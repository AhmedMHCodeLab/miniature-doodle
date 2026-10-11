package main

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

const testAdminPassword = "correct horse battery staple"

var adminLogin = `{"email":"admin@test.com","password":"` + testAdminPassword + `"}`

func init() {
	adminEmail = "admin@test.com"
	adminDigest = sha256.Sum256([]byte(testAdminPassword))
	adminConfigured = true
}

func TestNoAdminPasswordMeansNobodyLogsIn(t *testing.T) {
	setLimits(t, 1000, 1000, 1000, "")
	adminConfigured = false
	adminDigest = sha256.Sum256(nil) // what an empty password would hash to
	t.Cleanup(func() {
		adminConfigured = true
		adminDigest = sha256.Sum256([]byte(testAdminPassword))
	})
	rec := httptest.NewRecorder()
	handleLogin(rec, request("POST", "/auth/login", "203.0.113.34:1", `{"email":"admin@test.com","password":""}`))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("login with no admin password configured: got %d, want 401", rec.Code)
	}
}

func TestLoginNeedsTheAdminPassword(t *testing.T) {
	setLimits(t, 1000, 1000, 1000, "")
	jwtSecret = []byte("test-secret")
	cases := []struct {
		name, body string
		want       int
	}{
		{"right email and password", adminLogin, http.StatusOK},
		{"email in another case and with spaces", `{"email":" Admin@Test.com ","password":"` + testAdminPassword + `"}`, http.StatusOK},
		{"wrong password", `{"email":"admin@test.com","password":"guess"}`, http.StatusUnauthorized},
		{"any other email", `{"email":"someone@test.com","password":"` + testAdminPassword + `"}`, http.StatusUnauthorized},
		{"empty password", `{"email":"admin@test.com","password":""}`, http.StatusUnauthorized},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		handleLogin(rec, request("POST", "/auth/login", "203.0.113.30:1", c.body))
		if rec.Code != c.want {
			t.Errorf("%s: got %d, want %d", c.name, rec.Code, c.want)
		}
	}
}

func TestLoginTokenSaysAdmin(t *testing.T) {
	setLimits(t, 1000, 1000, 1000, "")
	jwtSecret = []byte("test-secret")
	rec := httptest.NewRecorder()
	handleLogin(rec, request("POST", "/auth/login", "203.0.113.31:1", adminLogin))
	var body struct{ Token string }
	_ = json.NewDecoder(rec.Body).Decode(&body)
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(body.Token, claims, func(*jwt.Token) (interface{}, error) { return jwtSecret, nil }); err != nil {
		t.Fatalf("token does not verify: %v", err)
	}
	if claims["sub"] != "admin@test.com" || claims["role"] != "admin" {
		t.Fatalf("got sub=%v role=%v, want the admin account", claims["sub"], claims["role"])
	}
}

func TestRegisterIsClosed(t *testing.T) {
	setLimits(t, 1000, 1000, 1000, "")
	rec := httptest.NewRecorder()
	handleRegister(rec, request("POST", "/auth/register", "203.0.113.32:1", `{"email":"new@test.com","password":"x"}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("register: got %d, want 403", rec.Code)
	}
	if rec.Header().Get("Content-Type") == "" || rec.Body.Len() == 0 {
		t.Fatalf("register: want an error body")
	}
}

// A client must not be able to tell a service who it is by sending the identity
// headers itself, on a public route or on a logged-in one.
func TestClientCannotSetIdentityHeaders(t *testing.T) {
	setLimits(t, 1000, 1000, 1000, "")
	var gotEmail, gotRole string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotEmail, gotRole = r.Header.Get("X-User-Email"), r.Header.Get("X-User-Role")
	}))
	t.Cleanup(up.Close)
	routes = map[string]string{"/api/orders": up.URL, "/api/shipping": up.URL}

	r := request("POST", "/api/shipping/webhook", "203.0.113.33:1", `{}`)
	r.Header.Set("X-User-Email", "boss@test.com")
	r.Header.Set("X-User-Role", "admin")
	handleProxy(httptest.NewRecorder(), r)
	if gotEmail != "" || gotRole != "" {
		t.Fatalf("public route forwarded client identity headers: email=%q role=%q", gotEmail, gotRole)
	}

	// A token with no role claim must not let a client-supplied role through.
	tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": "a@test.com", "exp": 9999999999}).SignedString(jwtSecret)
	r = request("GET", "/api/orders/", "203.0.113.33:2", "")
	r.Header.Set("Authorization", "Bearer "+tok)
	r.Header.Set("X-User-Role", "admin")
	handleProxy(httptest.NewRecorder(), r)
	if gotEmail != "a@test.com" || gotRole != "" {
		t.Fatalf("logged-in route: got email=%q role=%q, want the token's email and no role", gotEmail, gotRole)
	}
}
