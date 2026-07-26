package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
)

func main() {
	privateOutput := flag.String("private-out", "", "write the private key to this file instead of stdout")
	flag.Parse()
	encoded := os.Getenv("AUTO_VOUCHER_RELEASE_PRIVATE_KEY")
	ephemeral := false
	var privateKey ed25519.PrivateKey
	if encoded == "" {
		_, generated, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			panic(err)
		}
		privateKey = generated
		ephemeral = true
	} else {
		value, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			panic(err)
		}
		if len(value) == ed25519.SeedSize {
			privateKey = ed25519.NewKeyFromSeed(value)
		} else if len(value) == ed25519.PrivateKeySize {
			privateKey = ed25519.PrivateKey(value)
		} else {
			panic("release private key must be 32 or 64 bytes")
		}
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	if *privateOutput == "" {
		panic("-private-out is required so private keys never enter command output")
	}
	if err := os.WriteFile(
		*privateOutput,
		[]byte(base64.StdEncoding.EncodeToString(privateKey)),
		0o600,
	); err != nil {
		panic(err)
	}
	fmt.Printf("public_key=%s\n", base64.StdEncoding.EncodeToString(publicKey))
	fmt.Printf("ephemeral=%t\n", ephemeral)
}
