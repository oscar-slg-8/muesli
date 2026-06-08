#!/usr/bin/env bash
# setup-selfsigned-cert.sh
# Crée (une fois) un certificat de signature de code AUTO-SIGNÉ local et l'importe
# dans un trousseau dédié. Réutilisé par scripts/sign-selfsigned.js à chaque build
# pour donner à Muesli une identité de code STABLE → la permission Micro (TCC)
# persiste entre les mises à jour. Gratuit, sans compte Apple Developer.
#
# Idempotent : relancer recrée proprement le trousseau.
# Le trousseau et la clé privée restent LOCAUX (jamais commités).
set -euo pipefail

IDENTITY="Muesli Self Signed"
KEYCHAIN="$HOME/Library/Keychains/muesli-signing.keychain-db"
KEYCHAIN_PASSWORD="muesli"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Génération du certificat auto-signé (code signing)…"
cat > "$TMP/cert.conf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Muesli Self Signed
O = Muesli
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 3650 -nodes -config "$TMP/cert.conf" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/cert.p12" -name "$IDENTITY" -passout pass:"$KEYCHAIN_PASSWORD" >/dev/null 2>&1

echo "→ (Re)création du trousseau dédié $KEYCHAIN…"
security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"            # pas d'auto-lock
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "$KEYCHAIN_PASSWORD" -T /usr/bin/codesign -A
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
# Ajouter au search list sans virer les autres trousseaux
EXISTING=$(security list-keychains -d user | sed 's/[" ]//g' | tr '\n' ' ')
security list-keychains -d user -s "$KEYCHAIN" $EXISTING

echo "✓ Identité installée :"
security find-identity -p codesigning "$KEYCHAIN" | grep "$IDENTITY" || true
echo "  Les prochains 'npm run dist' signeront Muesli avec « $IDENTITY »."
