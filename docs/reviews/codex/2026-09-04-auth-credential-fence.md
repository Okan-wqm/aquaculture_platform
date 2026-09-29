# Auth Credential Issuance Fence Finding

## SEC-HIGH-131

After a successful login, auth-service saves login metadata before issuing tokens. PostgreSQL
stores the resulting `updatedAt` value with microsecond precision, while JavaScript `Date` retains
only milliseconds. Token issuance then uses that lossy timestamp as an exact row predicate, so an
unchanged active user can fail the credential fence with `User credentials changed during token
issuance`. All three active production users currently have sub-millisecond `updatedAt` values.

Resolution: fence token issuance on the credential and authorization fields that can invalidate the
authenticated snapshot (`password`, `role`, `tenantId`, and `isActive`) rather than a general-purpose
persistence timestamp. Regression coverage must prove both that non-credential timestamp precision
cannot reject an unchanged user and that a changed password still prevents token issuance.
