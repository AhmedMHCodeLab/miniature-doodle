# App hardening: ready patches (applied)

Both patches were applied on 26 Sep as commits, so they are no longer part of hardening:

- Patch 1 is commit cb5f19a on the ALPHA-51 branch (PR #31).
- Patch 2 is commit f507ac3 on the ALPHA-45 branch (PR #33).

This page is kept only as a record until those PRs merge. After that the commits are the source of truth and this page can be deleted.

Test results on 26 Sep:
- Patch 1: 4 new tests; 5 runs in a row with the race detector. The old code fails 3 of them. Removing either half of the fix makes its test fail again.
- Patch 2: 12 worker tests pass with the race detector. Removing the new status check makes 3 of them fail.

## Patch 1: order-service status changes safe to repeat and to race

Asking for the status an order already has returns 200 with `changed: false`, and nothing is written. The UPDATE only applies if the status is still the one read (`AND status = $3`). If it changed in between, the handler reads it again: a match gives 200, anything else gives 409.

```diff
--- a/services/order-service/main.go	2026-09-24 01:44:19.343742469 +0300
+++ b/services/order-service/main.go	2026-09-26 00:07:23.180091430 +0300
@@ -384,6 +384,13 @@
 		return
 	}
 
+	// Asking for the status the order already has is a repeat (for example a redelivered
+	// SQS message), not a conflict. Answer 200 and change nothing.
+	if currentStatus == req.NewStatus {
+		writeStatusChange(w, req.OrderID, currentStatus, req.NewStatus, false)
+		return
+	}
+
 	// Validate transition
 	allowed, ok := validTransitions[currentStatus]
 	if !ok {
@@ -404,8 +411,6 @@
 	}
 
 	// One transaction: status change, history row and outbox event are saved together.
-	// NOTE: the read-validate-update race (two concurrent transitions both accepted) is
-	// NOT fixed here; that is the next slice (compare-and-set on the UPDATE).
 	tx, err := db.Begin()
 	if err != nil {
 		httpError(w, "failed to update order", http.StatusInternalServerError)
@@ -413,13 +418,35 @@
 	}
 	defer tx.Rollback()
 
-	if _, err := tx.Exec(
-		"UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
-		req.NewStatus, req.OrderID,
-	); err != nil {
+	// Only change the status if it is still the one we read (compare-and-set). If another
+	// request changed it in between, Postgres re-checks this WHERE against the new row and
+	// updates nothing, so two concurrent changes can't both win.
+	res, err := tx.Exec(
+		"UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND status = $3",
+		req.NewStatus, req.OrderID, currentStatus,
+	)
+	if err != nil {
 		httpError(w, "failed to update order", http.StatusInternalServerError)
 		return
 	}
+	if n, err := res.RowsAffected(); err != nil {
+		httpError(w, "failed to update order", http.StatusInternalServerError)
+		return
+	} else if n == 0 {
+		tx.Rollback()
+		var nowStatus string
+		if err := db.QueryRow("SELECT status FROM orders WHERE id = $1", req.OrderID).Scan(&nowStatus); err != nil {
+			httpError(w, "failed to update order", http.StatusInternalServerError)
+			return
+		}
+		if nowStatus == req.NewStatus {
+			// A concurrent copy of the same request got there first.
+			writeStatusChange(w, req.OrderID, nowStatus, req.NewStatus, false)
+			return
+		}
+		httpError(w, fmt.Sprintf("order changed to %s while updating", nowStatus), http.StatusConflict)
+		return
+	}
 
 	// Record event
 	if _, err := tx.Exec(
@@ -447,11 +474,18 @@
 		return
 	}
 
+	writeStatusChange(w, req.OrderID, currentStatus, req.NewStatus, true)
+}
+
+// writeStatusChange answers a status request. changed is false when the order was
+// already in the requested status, so nothing was written.
+func writeStatusChange(w http.ResponseWriter, orderID int, oldStatus, newStatus string, changed bool) {
 	w.Header().Set("Content-Type", "application/json")
 	json.NewEncoder(w).Encode(map[string]interface{}{
-		"order_id":   req.OrderID,
-		"old_status": currentStatus,
-		"new_status": req.NewStatus,
+		"order_id":   orderID,
+		"old_status": oldStatus,
+		"new_status": newStatus,
+		"changed":    changed,
 	})
 }
 
```

New file `services/order-service/status_test.go`:

```go
package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// putStatus sends PUT /status for order 1 and returns the response code.
func putStatus(t *testing.T, status string) int {
	t.Helper()
	body := fmt.Sprintf(`{"order_id":1,"new_status":%q}`, status)
	req := httptest.NewRequest(http.MethodPut, "/status", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	handleUpdateStatus(rec, req)
	return rec.Code
}

func orderStatus(t *testing.T) string {
	t.Helper()
	var s string
	if err := db.QueryRow(`SELECT status FROM orders WHERE id = 1`).Scan(&s); err != nil {
		t.Fatalf("read status: %v", err)
	}
	return s
}

// warmPool opens n connections so concurrent requests really run at the same time.
func warmPool(t *testing.T, n int) {
	t.Helper()
	db.SetMaxOpenConns(n)
	db.SetMaxIdleConns(n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := db.Exec(`SELECT pg_sleep(0.05)`); err != nil {
				t.Errorf("warm: %v", err)
			}
		}()
	}
	wg.Wait()
}

// A redelivered message asks for the status the order already has. That is a repeat,
// not a conflict: answer 200 and change nothing.
func TestSameStatusAgainIsSuccessAndChangesNothing(t *testing.T) {
	setupTestDB(t)
	t.Cleanup(func() { db.Close() })
	if rec := postOrder(t); rec.Code != http.StatusCreated {
		t.Fatalf("create order: %d", rec.Code)
	}
	if code := putStatus(t, "confirmed"); code != http.StatusOK {
		t.Fatalf("first confirm: got %d, want 200", code)
	}

	if code := putStatus(t, "confirmed"); code != http.StatusOK {
		t.Fatalf("repeat confirm: got %d, want 200", code)
	}

	if n := count(t, `SELECT count(*) FROM order_events WHERE order_id = 1 AND event_type = 'status_changed'`); n != 1 {
		t.Errorf("history rows: got %d, want 1", n)
	}
	if n := count(t, `SELECT count(*) FROM order_outbox WHERE event_type = 'order.status_changed'`); n != 1 {
		t.Errorf("status events: got %d, want 1", n)
	}
}

// Confirm and cancel arrive at the same time. Exactly one may win; the loser gets 409.
func TestConcurrentConfirmAndCancelOnlyOneWins(t *testing.T) {
	setupTestDB(t)
	t.Cleanup(func() { db.Close() })
	warmPool(t, 4)

	for run := 0; run < 30; run++ {
		if _, err := db.Exec(`TRUNCATE order_outbox, order_events, orders RESTART IDENTITY CASCADE`); err != nil {
			t.Fatalf("truncate: %v", err)
		}
		if rec := postOrder(t); rec.Code != http.StatusCreated {
			t.Fatalf("create order: %d", rec.Code)
		}

		codes := make([]int, 2)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i, status := range []string{"confirmed", "cancelled"} {
			wg.Add(1)
			go func(i int, status string) {
				defer wg.Done()
				<-start
				codes[i] = putStatus(t, status)
			}(i, status)
		}
		close(start)
		wg.Wait()

		wins := 0
		for _, c := range codes {
			if c == http.StatusOK {
				wins++
			}
		}
		if wins != 1 {
			t.Fatalf("run %d: confirm=%d cancel=%d, want exactly one 200 (final status %s)", run, codes[0], codes[1], orderStatus(t))
		}
		if n := count(t, `SELECT count(*) FROM order_outbox WHERE event_type = 'order.status_changed'`); n != 1 {
			t.Fatalf("run %d: status events: got %d, want 1", run, n)
		}
	}
}

// Two copies of the same message confirm at the same time. Both succeed (the second is a
// repeat) but the order changes, and emits its event, only once.
func TestConcurrentSameConfirmBothSucceedOnce(t *testing.T) {
	setupTestDB(t)
	t.Cleanup(func() { db.Close() })
	warmPool(t, 4)

	for run := 0; run < 30; run++ {
		if _, err := db.Exec(`TRUNCATE order_outbox, order_events, orders RESTART IDENTITY CASCADE`); err != nil {
			t.Fatalf("truncate: %v", err)
		}
		if rec := postOrder(t); rec.Code != http.StatusCreated {
			t.Fatalf("create order: %d", rec.Code)
		}

		codes := make([]int, 2)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				codes[i] = putStatus(t, "confirmed")
			}(i)
		}
		close(start)
		wg.Wait()

		if codes[0] != http.StatusOK || codes[1] != http.StatusOK {
			t.Fatalf("run %d: got %v, want both 200", run, codes)
		}
		if n := count(t, `SELECT count(*) FROM order_outbox WHERE event_type = 'order.status_changed'`); n != 1 {
			t.Fatalf("run %d: status events: got %d, want 1", run, n)
		}
	}
}

// A real conflict still fails: a cancelled order can't be confirmed.
func TestConfirmAfterCancelIsStillRejected(t *testing.T) {
	setupTestDB(t)
	t.Cleanup(func() { db.Close() })
	if rec := postOrder(t); rec.Code != http.StatusCreated {
		t.Fatalf("create order: %d", rec.Code)
	}
	if code := putStatus(t, "cancelled"); code != http.StatusOK {
		t.Fatalf("cancel: got %d", code)
	}
	if code := putStatus(t, "confirmed"); code != http.StatusConflict {
		t.Fatalf("confirm after cancel: got %d, want 409", code)
	}
	if s := orderStatus(t); s != "cancelled" {
		t.Errorf("status: got %s, want cancelled", s)
	}
}
```

## Patch 2: worker checks the order's status before redoing any step

Before anything else, the worker reads the order's current status. If it's `pending`, the normal flow runs. If it's `cancelled`, the worker releases any held stock and stops, and never charges again. If it's `confirmed` or later, the worker only commits the stock.

```diff
--- a/services/worker/main.go	2026-09-25 02:39:35.985261719 +0300
+++ b/services/worker/main.go	2026-09-26 00:08:14.994833293 +0300
@@ -153,6 +153,26 @@
 // SQS retries it. Every call is safe to repeat (ALPHA-51), so a retry after a partial
 // run picks up where it left off.
 func processNewOrder(client *http.Client, services map[string]string, o newOrder) error {
+	// The same message can come back after the order was already finished: a redelivery,
+	// a DLQ redrive, or a crash before the delete. Check where the order is now and only
+	// finish what is missing. A cancelled order is never reserved or charged again.
+	status, err := getOrderStatus(client, services, o.OrderID)
+	if err != nil {
+		return err
+	}
+	switch status {
+	case "pending":
+		// Normal path below.
+	case "cancelled":
+		log.Printf("  -> order %d: already cancelled, making sure its stock is released", o.OrderID)
+		return releaseStock(client, services, o.OrderID)
+	default:
+		// confirmed or later: the charge already went through. Make sure the stock is
+		// committed; committing twice changes nothing.
+		log.Printf("  -> order %d: already %s, making sure its stock is committed", o.OrderID, status)
+		return commitStock(client, services, o.OrderID)
+	}
+
 	code, err := sendJSON(client, http.MethodPost, services["inventory"]+"/reserve", map[string]interface{}{
 		"order_id": o.OrderID,
 		"items":    o.Items,
@@ -183,14 +203,8 @@
 	case http.StatusCreated, http.StatusOK:
 	case http.StatusPaymentRequired:
 		log.Printf("  -> order %d: payment declined, releasing stock and cancelling", o.OrderID)
-		code, err := sendJSON(client, http.MethodPost, services["inventory"]+"/release", map[string]interface{}{
-			"order_id": o.OrderID,
-		})
-		if err != nil {
-			return fmt.Errorf("release after decline: %w", err)
-		}
-		if code != http.StatusOK {
-			return fmt.Errorf("release after decline: unexpected status %d", code)
+		if err := releaseStock(client, services, o.OrderID); err != nil {
+			return err
 		}
 		return setOrderStatus(client, services, o.OrderID, "cancelled")
 	default:
@@ -203,8 +217,46 @@
 
 	// Turn the held stock into a sale (ALPHA-77). Only after the confirm, so stock never
 	// leaves the shelf for an order that isn't confirmed.
-	code, err = sendJSON(client, http.MethodPost, services["inventory"]+"/commit", map[string]interface{}{
-		"order_id": o.OrderID,
+	return commitStock(client, services, o.OrderID)
+}
+
+// getOrderStatus asks order-service for the order's current status.
+func getOrderStatus(client *http.Client, services map[string]string, orderID int) (string, error) {
+	resp, err := client.Get(fmt.Sprintf("%s/%d", services["order"], orderID))
+	if err != nil {
+		return "", fmt.Errorf("get order: %w", err)
+	}
+	defer resp.Body.Close()
+	if resp.StatusCode != http.StatusOK {
+		return "", fmt.Errorf("get order: unexpected status %d", resp.StatusCode)
+	}
+	var order struct {
+		Status string `json:"status"`
+	}
+	if err := json.NewDecoder(resp.Body).Decode(&order); err != nil || order.Status == "" {
+		return "", fmt.Errorf("get order: unreadable response")
+	}
+	return order.Status, nil
+}
+
+// releaseStock releases any stock still held for the order. Safe to repeat.
+func releaseStock(client *http.Client, services map[string]string, orderID int) error {
+	code, err := sendJSON(client, http.MethodPost, services["inventory"]+"/release", map[string]interface{}{
+		"order_id": orderID,
+	})
+	if err != nil {
+		return fmt.Errorf("release stock: %w", err)
+	}
+	if code != http.StatusOK {
+		return fmt.Errorf("release stock: unexpected status %d", code)
+	}
+	return nil
+}
+
+// commitStock turns the order's held stock into a sale. Safe to repeat.
+func commitStock(client *http.Client, services map[string]string, orderID int) error {
+	code, err := sendJSON(client, http.MethodPost, services["inventory"]+"/commit", map[string]interface{}{
+		"order_id": orderID,
 	})
 	if err != nil {
 		return fmt.Errorf("commit stock: %w", err)
```

Test changes:

```diff
--- a/services/worker/main_test.go	2026-09-25 02:39:35.985427824 +0300
+++ b/services/worker/main_test.go	2026-09-26 00:08:05.667763642 +0300
@@ -21,14 +21,20 @@
 // call ("POST /reserve", "PUT /status confirmed", ...) and answers with the status
 // codes the test sets.
 type fakeServices struct {
-	mu    sync.Mutex
-	calls []string
-	codes map[string]int // path -> status code, default 200
+	mu          sync.Mutex
+	calls       []string
+	codes       map[string]int // path -> status code, default 200
+	orderStatus string         // what GET /42 reports, default "pending"
 }
 
 func newFakeServices(t *testing.T, codes map[string]int) (*fakeServices, map[string]string) {
 	t.Helper()
-	f := &fakeServices{codes: codes}
+	return newFakeServicesWithStatus(t, codes, "pending")
+}
+
+func newFakeServicesWithStatus(t *testing.T, codes map[string]int, orderStatus string) (*fakeServices, map[string]string) {
+	t.Helper()
+	f := &fakeServices{codes: codes, orderStatus: orderStatus}
 	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
 		call := r.Method + " " + r.URL.Path
 		if r.URL.Path == "/status" {
@@ -46,6 +52,9 @@
 			code = http.StatusOK
 		}
 		w.WriteHeader(code)
+		if r.Method == http.MethodGet && code == http.StatusOK {
+			json.NewEncoder(w).Encode(map[string]string{"status": f.orderStatus})
+		}
 	}))
 	t.Cleanup(srv.Close)
 	return f, map[string]string{"inventory": srv.URL, "payment": srv.URL, "order": srv.URL}
@@ -79,7 +88,7 @@
 	if err != nil {
 		t.Fatalf("got error %v, want nil (message deleted)", err)
 	}
-	assertCalls(t, calls, []string{"POST /reserve", "POST /charge", "PUT /status confirmed", "POST /commit"})
+	assertCalls(t, calls, []string{"GET /42", "POST /reserve", "POST /charge", "PUT /status confirmed", "POST /commit"})
 }
 
 func TestRepeatedOrderCreatedStillConfirms(t *testing.T) {
@@ -88,7 +97,7 @@
 	if err != nil {
 		t.Fatalf("got error %v, want nil", err)
 	}
-	assertCalls(t, calls, []string{"POST /reserve", "POST /charge", "PUT /status confirmed", "POST /commit"})
+	assertCalls(t, calls, []string{"GET /42", "POST /reserve", "POST /charge", "PUT /status confirmed", "POST /commit"})
 }
 
 func TestOutOfStockCancelsWithoutCharging(t *testing.T) {
@@ -96,7 +105,7 @@
 	if err != nil {
 		t.Fatalf("got error %v, want nil (final answer, message deleted)", err)
 	}
-	assertCalls(t, calls, []string{"POST /reserve", "PUT /status cancelled"})
+	assertCalls(t, calls, []string{"GET /42", "POST /reserve", "PUT /status cancelled"})
 }
 
 func TestDeclinedCardReleasesStockAndCancels(t *testing.T) {
@@ -104,7 +113,7 @@
 	if err != nil {
 		t.Fatalf("got error %v, want nil (final answer, message deleted)", err)
 	}
-	assertCalls(t, calls, []string{"POST /reserve", "POST /charge", "POST /release", "PUT /status cancelled"})
+	assertCalls(t, calls, []string{"GET /42", "POST /reserve", "POST /charge", "POST /release", "PUT /status cancelled"})
 }
 
 func TestPaymentOutageKeepsMessageForRetry(t *testing.T) {
@@ -113,7 +122,7 @@
 		t.Fatal("got nil, want an error so the message stays on the queue")
 	}
 	// Stock stays held and the order stays pending; the retry picks up from here.
-	assertCalls(t, calls, []string{"POST /reserve", "POST /charge"})
+	assertCalls(t, calls, []string{"GET /42", "POST /reserve", "POST /charge"})
 }
 
 func TestInventoryUnreachableKeepsMessageForRetry(t *testing.T) {
@@ -128,7 +137,7 @@
 	if err == nil {
 		t.Fatal("got nil, want an error so the message stays on the queue")
 	}
-	assertCalls(t, calls, []string{"POST /reserve", "POST /charge", "PUT /status confirmed", "POST /commit"})
+	assertCalls(t, calls, []string{"GET /42", "POST /reserve", "POST /charge", "PUT /status confirmed", "POST /commit"})
 }
 
 func TestEventsWithoutHandlerAreSkipped(t *testing.T) {
@@ -179,3 +188,44 @@
 		t.Errorf("queue not empty after delete: %v", attrs.Attributes)
 	}
 }
+
+func runWithStatus(t *testing.T, codes map[string]int, orderStatus string) ([]string, error) {
+	t.Helper()
+	f, services := newFakeServicesWithStatus(t, codes, orderStatus)
+	err := handleEvent(&http.Client{Timeout: 2 * time.Second}, services, orderCreated(t))
+	return f.calls, err
+}
+
+func TestRedeliveryOfConfirmedOrderOnlyCommitsStock(t *testing.T) {
+	// The first run confirmed the order but its commit failed; this is the retry.
+	calls, err := runWithStatus(t, nil, "confirmed")
+	if err != nil {
+		t.Fatalf("got error %v, want nil", err)
+	}
+	assertCalls(t, calls, []string{"GET /42", "POST /commit"})
+}
+
+func TestRedeliveryOfCancelledOrderNeverChargesAgain(t *testing.T) {
+	// The first run cancelled the order (declined card) but the delete failed.
+	calls, err := runWithStatus(t, nil, "cancelled")
+	if err != nil {
+		t.Fatalf("got error %v, want nil", err)
+	}
+	assertCalls(t, calls, []string{"GET /42", "POST /release"})
+}
+
+func TestOrderServiceDownKeepsMessageForRetry(t *testing.T) {
+	calls, err := run(t, map[string]int{"/42": 503}, orderCreated(t))
+	if err == nil {
+		t.Fatal("got nil, want an error so the message stays on the queue")
+	}
+	assertCalls(t, calls, []string{"GET /42"})
+}
+
+func TestReleaseFailureOnCancelledOrderKeepsMessageForRetry(t *testing.T) {
+	calls, err := runWithStatus(t, map[string]int{"/release": 500}, "cancelled")
+	if err == nil {
+		t.Fatal("got nil, want an error so the message stays on the queue")
+	}
+	assertCalls(t, calls, []string{"GET /42", "POST /release"})
+}
```
