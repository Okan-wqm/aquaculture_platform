# Research: OPC UA Security — SignAndEncrypt, Certificate Management, IEC 62443-4-2 Mapping

**Topic:** Production-grade OPC UA client/server security: encrypted sessions, certificate validation, trust list management, CRL handling, IEC 62443-4-2 conformance.
**Date:** 2026-04-08
**Agent:** sensor-expert

## Sources
- [OPC Foundation Reference — Part 2 Security (v1.05)](https://reference.opcfoundation.org/Core/Part2/v105/docs/)
- [OPC Foundation Reference — Part 2 Annex A (Mapping to ISA/IEC 62443-4-2)](https://reference.opcfoundation.org/Core/Part2/v105/docs/A)
- [OPC Foundation Reference — Part 2 Section 8 Certificate Management](https://reference.opcfoundation.org/Core/Part2/v104/docs/8)
- [Eclatron: OPC UA Security Best Practices — Complete Guide](https://www.eclatron.com/post/opc-ua-security-best-practices-a-complete-guide-to-securing-industrial-iot-communications)
- [Understanding OPC UA Certificates and CAs (Software Toolbox)](https://blog.softwaretoolbox.com/understanding-opc-ua-certificates-and-authorities)
- [Manubes: Security in OPC UA — Overview of Mechanisms](https://www.manubes.com/opc-ua-security/)
- [SCADA Protocols: OPC UA Security](https://scadaprotocols.com/opc-ua-security/)
- [Unified Automation: Certificate validation / User identity token forum threads](https://forum.unified-automation.com/)

## Key Findings

1. **SignAndEncrypt is the mandatory production security mode.** Messages are both signed (integrity, no tampering) and encrypted (confidentiality, no eavesdropping). Anything less — None, Sign-only — is NOT acceptable for production OPC UA deployments per IEC 62541 recommendations.
2. **Every OPC UA application has an Application Instance Certificate** containing: application URI (globally unique), public key, issuer identity, validity period, digital signature. This certificate identifies the application to peers during SecureChannel establishment.
3. **Trust list management** is the core identity primitive. Clients and servers maintain a list of trusted certificates (CAs or explicit peer certificates). A certificate not in the trust list MUST be rejected at SecureChannel establishment.
4. **Self-signed certificates** are acceptable for initial setup (bootstrapping) but MUST be replaceable with CA-signed certificates in production. Self-signed without explicit organizational approval + documented trust relationship = HIGH compliance gap.
5. **Company-specific CA recommended over commercial CA** for industrial OPC UA — gives control over issuance, revocation, and deployment. Commercial CAs add trust chain complexity that is inappropriate for closed industrial networks.
6. **Certificate Revocation List (CRL) handling** is mandatory. Applications MUST check CRLs on SecureChannel establishment and MUST refuse connections from revoked certificates. Missing CRL check = HIGH.
7. **Nonce values** in SecureChannel establishment prevent replay attacks. Nonce reuse = CRITICAL.
8. **User identity tokens** are separate from application identity. A client authenticates its application via certificate AND its user via a UserIdentityToken (username/password, X.509, or anonymous). Anonymous user tokens in production on tenant data = CRITICAL.
9. **Role-based access control** — OPC UA 1.05 supports Role objects for authorization. Servers SHOULD enforce AccessRestriction on nodes based on the authenticated user role. Missing role-based enforcement = HIGH.
10. **IEC 62443-4-2 mapping** (OPC UA Annex A) shows how OPC UA security mechanisms satisfy IEC 62443 component requirements. SR 1.1 (human user identification) ↔ UserIdentityToken; SR 3.1 (communication integrity) ↔ SignAndEncrypt signing; SR 4.1 (information confidentiality) ↔ SignAndEncrypt encryption; etc.
11. **Audit logging** — every security-relevant operation (SecureChannel open/close, authentication success/failure, certificate validation, role check) MUST be audit-logged per OPC Foundation Section 8 and IEC 62443-3-3 SR 2.8.
12. **Key storage** — private keys MUST be stored with appropriate OS-level protection (key stores, HSM, file permissions). World-readable private key files = CRITICAL.
13. **Key rotation** — section 6.8 of the spec provides guidance; certificates have validity periods and MUST be renewed before expiry. Missing automated renewal → service outage at expiry.

## Security Concerns
- SecurityMode anything other than SignAndEncrypt in production = CRITICAL.
- `danger_accept_invalid_certs` / disabled certificate validation = CRITICAL.
- Missing CRL check on SecureChannel establishment = HIGH.
- Anonymous UserIdentityToken on tenant data = CRITICAL.
- Private key stored with world-readable file permissions or unencrypted in DB = CRITICAL.
- Missing certificate expiry monitoring = HIGH (service outage).
- Self-signed certificates in production without documented trust agreement = HIGH.
- Missing audit logging of security-relevant operations = HIGH (IEC 62443-3-3 SR 2.8 violation).
- Nonce reuse across sessions = CRITICAL (replay attack window).

## Performance Concerns
- SignAndEncrypt adds per-message crypto overhead — tune SecureChannel lifetime (shorter = more re-establishment overhead; longer = longer window for compromise).
- Certificate validation on every SecureChannel establishment — cache validation results per certificate fingerprint within the certificate's validity period.
- CRL fetches can be slow if the CRL distribution point is remote — cache CRLs with configurable refresh period.

## Architectural Implications for sensor-expert reviews
- Any OPC UA client configuration with SecurityMode other than SignAndEncrypt in production code paths = CRITICAL.
- Any OPC UA client code that skips certificate validation = CRITICAL.
- Missing CRL handling = HIGH.
- Anonymous user identity on tenant data = CRITICAL.
- Private keys in source repo, unencrypted database column, or world-readable file = CRITICAL.
- Missing certificate expiry monitor (30-day / 7-day alert) = HIGH.
- Missing OPC UA role-based access enforcement on nodes = HIGH.
- Missing audit log of SecureChannel lifecycle events = HIGH.

## Domain Rule Additions for sensor-expert

Add to `## Domain Rules → PLC Control` (extend OPC UA section):
- OPC UA SecurityMode MUST be `SignAndEncrypt` in production. None or Sign-only = CRITICAL.
- Certificate validation MUST be enforced — no `accept_invalid_certs` or equivalent bypass. Bypass = CRITICAL.
- Certificate Revocation List (CRL) MUST be checked on SecureChannel establishment and cached with configurable refresh. Missing CRL check = HIGH.
- Trust list management MUST use a company-specific CA for production; self-signed certificates permitted only with documented organizational approval (bootstrap only). Self-signed in production without approval = HIGH.
- UserIdentityToken on tenant data MUST be a real user token (username/password or X.509), never anonymous. Anonymous on tenant data = CRITICAL.
- Private keys MUST be stored in an OS-level keystore, HSM, or filesystem with mode 0600. World-readable or repo-committed private keys = CRITICAL.
- Certificate expiry MUST be monitored (30-day warning, 7-day critical). Missing monitor = HIGH (certain outage at expiry).
- SecureChannel lifecycle events (open, close, authentication success/failure, cert validation result) MUST be audit-logged per IEC 62443-3-3 SR 2.8. Missing audit log = HIGH.
- Role-based access control on OPC UA nodes MUST be enforced using the OPC UA 1.05 Role model. Missing role enforcement = HIGH.
