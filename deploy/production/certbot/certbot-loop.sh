#!/bin/sh
set -eu

CERT_NAME=matrixspooll
WEBROOT=/var/www/certbot
CERT_SOURCE=/etc/letsencrypt/live/$CERT_NAME
TLS_TARGET=/etc/nginx/tls
RETRY_SECONDS=300
RENEW_INTERVAL_SECONDS=21600

validate_configuration() {
    case "${PUBLIC_HOST:-}" in
        ""|*://*|*/*|*:*|*[!A-Za-z0-9.-]*)
            echo "PUBLIC_HOST must be a DNS name or IPv4 address without scheme, path, or port" >&2
            exit 1
            ;;
    esac
    if [ -z "${CERTBOT_EMAIL:-}" ]; then
        echo "CERTBOT_EMAIL is required" >&2
        exit 1
    fi
}

is_ipv4_address() {
    printf '%s\n' "$PUBLIC_HOST" | awk -F. '
        NF != 4 { exit 1 }
        {
            for (i = 1; i <= 4; i++) {
                if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
            }
        }
    '
}

request_certificate() {
    set -- certonly \
        --non-interactive \
        --agree-tos \
        --email "$CERTBOT_EMAIL" \
        --webroot \
        --webroot-path "$WEBROOT" \
        --cert-name "$CERT_NAME" \
        --keep-until-expiring

    if is_ipv4_address; then
        set -- "$@" --preferred-profile shortlived --ip-address "$PUBLIC_HOST"
    else
        set -- "$@" --domain "$PUBLIC_HOST"
    fi

    certbot "$@"
}

publish_certificate() {
    [ -s "$CERT_SOURCE/fullchain.pem" ] || return 1
    [ -s "$CERT_SOURCE/privkey.pem" ] || return 1

    mkdir -p "$TLS_TARGET"
    cp -L "$CERT_SOURCE/fullchain.pem" "$TLS_TARGET/fullchain.pem.new"
    cp -L "$CERT_SOURCE/privkey.pem" "$TLS_TARGET/privkey.pem.new"
    chmod 0644 "$TLS_TARGET/fullchain.pem.new" "$TLS_TARGET/privkey.pem.new"
    mv "$TLS_TARGET/fullchain.pem.new" "$TLS_TARGET/fullchain.pem"
    mv "$TLS_TARGET/privkey.pem.new" "$TLS_TARGET/privkey.pem"
}

validate_configuration

until [ -s "$CERT_SOURCE/fullchain.pem" ] && [ -s "$CERT_SOURCE/privkey.pem" ]; do
    if request_certificate; then
        break
    fi
    echo "Certificate issuance failed; retrying in $RETRY_SECONDS seconds" >&2
    sleep "$RETRY_SECONDS"
done

publish_certificate

while :; do
    certbot renew \
        --webroot \
        --webroot-path "$WEBROOT" \
        --no-random-sleep-on-renew \
        --quiet || true
    publish_certificate || true
    sleep "$RENEW_INTERVAL_SECONDS"
done
