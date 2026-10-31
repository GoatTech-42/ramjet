# rollback posture for the epoxy-tls net transport

if the 2.1.20-1 repair bundle must be reverted, the previous artifact
(@mercuryworkshop/epoxy-tls 2.1.19-1, wasm sha256 4e26f08ff06635cddc70b4449145490fd9a00b01fbfe318c2f62b0d22800508e)
restores SERVICE AVAILABILITY ONLY.

that artifact is deprecated upstream: it trusts the compromised eMudhra
intermediate CAs (Oct 2026). a rollback is therefore an availability recovery
with a known deprecated trust base - NOT a security-acceptable steady state
and NOT a security sign-off. after any rollback, re-apply the repaired bundle
or take the affected transport path out of service; do not leave the deprecated
artifact in place by default.

corresponding source for the legacy artifact remains published alongside this
note (epoxy-tls-93d5a726-source.tar.gz) for as long as the legacy artifact is
or was served.
