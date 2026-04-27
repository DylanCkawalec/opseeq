package main

import "testing"

func TestIsSafeRunID(t *testing.T) {
	valid := []string{
		"01KQ6355N5EKHM2AK55RT4FH0J",
		"run_abc-123",
	}
	for _, id := range valid {
		if !isSafeRunID(id) {
			t.Fatalf("expected %q to be safe", id)
		}
	}

	invalid := []string{
		"",
		"../secret",
		"run/secret",
		"run.secret",
		"run%2fsecret",
	}
	for _, id := range invalid {
		if isSafeRunID(id) {
			t.Fatalf("expected %q to be rejected", id)
		}
	}
}
