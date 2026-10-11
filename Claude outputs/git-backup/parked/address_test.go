package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

const addressBody = `{"items":[{"product_id":"p1","quantity":1}],
	"shipping_address":{"name":" Sam Shopper ","line1":"1 High St","city":"Leeds","postcode":"LS1 1AA","country":"gb"}}`

func getOrderJSON(t *testing.T, id int) Order {
	t.Helper()
	rec := httptest.NewRecorder()
	handleOrders(rec, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/%d", id), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("get order %d: %d %s", id, rec.Code, rec.Body)
	}
	var o Order
	if err := json.Unmarshal(rec.Body.Bytes(), &o); err != nil {
		t.Fatalf("decode order: %v", err)
	}
	return o
}

func TestOrderKeepsItsShippingAddress(t *testing.T) {
	setupTestDB(t)
	rec := postOrderWithKey(t, "addr-1", addressBody)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	o := getOrderJSON(t, orderIDFrom(t, rec.Body.Bytes()))
	var a Address
	if err := json.Unmarshal(o.ShippingAddress, &a); err != nil {
		t.Fatalf("shipping_address missing or unreadable: %q", o.ShippingAddress)
	}
	want := Address{Name: "Sam Shopper", Line1: "1 High St", City: "Leeds", Postcode: "LS1 1AA", Country: "GB"}
	if a != want {
		t.Fatalf("got %+v, want %+v (trimmed, country upper-cased)", a, want)
	}
}

func TestOrderWithoutAnAddressStillWorks(t *testing.T) {
	setupTestDB(t)
	rec := postOrder(t)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if o := getOrderJSON(t, orderIDFrom(t, rec.Body.Bytes())); len(o.ShippingAddress) != 0 {
		t.Fatalf("want no shipping_address, got %s", o.ShippingAddress)
	}
}

func TestBadAddressIsRejectedAndSavesNothing(t *testing.T) {
	setupTestDB(t)
	bad := []string{
		`{"name":"Sam","line1":"1 High St","postcode":"LS1 1AA"}`,                                // no city
		`{"name":"","line1":"1 High St","city":"Leeds","postcode":"LS1 1AA"}`,                    // no name
		`{"name":"Sam","line1":"1 High St","city":"Leeds","postcode":"LS1 1AA","country":"GBR"}`, // 3 letters
		`{"name":"Sam","line1":"1 High St","city":"Leeds","postcode":"LS1 1AA","country":"G1"}`,  // not letters
		fmt.Sprintf(`{"name":"Sam","line1":"1 High St","city":"Leeds","postcode":"%s"}`, "123456789012345678901"),
	}
	for i, a := range bad {
		body := fmt.Sprintf(`{"items":[{"product_id":"p1","quantity":1}],"shipping_address":%s}`, a)
		if rec := postOrderWithKey(t, fmt.Sprintf("bad-addr-%d", i), body); rec.Code != http.StatusBadRequest {
			t.Errorf("address %s: got %d, want 400", a, rec.Code)
		}
	}
	if n := count(t, `SELECT count(*) FROM orders`); n != 0 {
		t.Fatalf("%d orders saved from bad addresses", n)
	}
}

func TestSameKeyWithAnotherAddressIsRejected(t *testing.T) {
	setupTestDB(t)
	if rec := postOrderWithKey(t, "addr-2", addressBody); rec.Code != http.StatusCreated {
		t.Fatalf("first: %d", rec.Code)
	}
	other := `{"items":[{"product_id":"p1","quantity":1}],
		"shipping_address":{"name":"Sam Shopper","line1":"2 Other Rd","city":"Leeds","postcode":"LS1 1AA"}}`
	if rec := postOrderWithKey(t, "addr-2", other); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("same key, new address: got %d, want 422", rec.Code)
	}
}

// Keys stored before addresses existed must still match a retry without an address.
func TestFingerprintWithoutAddressIsUnchanged(t *testing.T) {
	items := []OrderItem{{ProductID: "p1", Quantity: 2}}
	old := struct {
		Items []struct {
			ProductID string `json:"p"`
			Quantity  int    `json:"q"`
		} `json:"items"`
		Currency string `json:"currency"`
		Notes    string `json:"notes"`
	}{Currency: "GBP", Notes: "n"}
	old.Items = append(old.Items, struct {
		ProductID string `json:"p"`
		Quantity  int    `json:"q"`
	}{"p1", 2})
	b, _ := json.Marshal(old)
	sum := sha256.Sum256(b)
	if got := requestFingerprint(items, "GBP", "n", nil); got != hex.EncodeToString(sum[:]) {
		t.Fatalf("fingerprint without an address changed")
	}
}
