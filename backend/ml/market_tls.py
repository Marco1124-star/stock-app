"""Let curl use the same trusted CA roots as Python/Windows, without disabling TLS."""
import os
import ssl
from pathlib import Path
import certifi


def configure_market_tls(cache_dir):
    if os.name != "nt" or os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("CURL_CA_BUNDLE"):
        return None  # Respect administrator/user configuration.
    try:
        roots = ssl.create_default_context().get_ca_certs(binary_form=True)
        if not roots:
            return None
        content = Path(certifi.where()).read_text(encoding="ascii")
        content += "\n" + "\n".join(ssl.DER_cert_to_PEM_cert(cert) for cert in roots)
        target = Path(cache_dir) / "windows-trusted-ca.pem"
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_text(encoding="ascii") != content:
            temporary = target.with_name(f"windows-trusted-ca.{os.getpid()}.tmp")
            temporary.write_text(content, encoding="ascii")
            os.replace(temporary, target)
        os.environ["CURL_CA_BUNDLE"] = str(target)
        return str(target)
    except (OSError, ssl.SSLError):
        return None  # Existing secure fallback, never verify=False.
