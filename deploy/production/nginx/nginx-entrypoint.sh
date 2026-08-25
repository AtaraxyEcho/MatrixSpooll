#!/bin/sh
set -eu

CONFIG_PATH=/etc/nginx/conf.d/default.conf
BOOTSTRAP_TEMPLATE=/opt/matrixspooll/bootstrap.conf.template
HTTPS_TEMPLATE=/opt/matrixspooll/https.conf.template
CERTIFICATE_PATH=/etc/nginx/tls/fullchain.pem
PRIVATE_KEY_PATH=/etc/nginx/tls/privkey.pem
FINGERPRINT_PATH=/tmp/matrixspooll-certificate-fingerprint

validate_public_host() {
    case "${PUBLIC_HOST:-}" in
        ""|*://*|*/*|*:*|*[!A-Za-z0-9.-]*)
            echo "PUBLIC_HOST must be a DNS name or IPv4 address without scheme, path, or port" >&2
            exit 1
            ;;
    esac
}

certificate_ready() {
    [ -s "$CERTIFICATE_PATH" ] && [ -s "$PRIVATE_KEY_PATH" ]
}

certificate_fingerprint() {
    if certificate_ready; then
        cksum "$CERTIFICATE_PATH" "$PRIVATE_KEY_PATH" | cksum | awk '{print $1 ":" $2}'
    else
        printf '%s\n' "missing"
    fi
}

render_config() {
    if certificate_ready; then
        template=$HTTPS_TEMPLATE
    else
        template=$BOOTSTRAP_TEMPLATE
    fi

    envsubst '${PUBLIC_HOST}' < "$template" > "${CONFIG_PATH}.new"
    mv "${CONFIG_PATH}.new" "$CONFIG_PATH"
    certificate_fingerprint > "$FINGERPRINT_PATH"
}

reload_when_certificate_changes() {
    while sleep 30; do
        current_fingerprint=$(certificate_fingerprint)
        previous_fingerprint=$(cat "$FINGERPRINT_PATH" 2>/dev/null || true)
        if [ "$current_fingerprint" = "$previous_fingerprint" ]; then
            continue
        fi

        cp "$CONFIG_PATH" "${CONFIG_PATH}.previous"
        render_config
        if nginx -t; then
            nginx -s reload
            rm -f "${CONFIG_PATH}.previous"
            echo "Nginx reloaded after TLS certificate change"
        else
            mv "${CONFIG_PATH}.previous" "$CONFIG_PATH"
            echo "TLS configuration validation failed; keeping the previous Nginx configuration" >&2
        fi
    done
}

validate_public_host
render_config
nginx -t
reload_when_certificate_changes &
exec nginx -g 'daemon off;'
