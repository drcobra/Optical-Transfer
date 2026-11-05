## GitHub Page

Exactly for user: https://drcobra.github.io/Optical-Transfer

## How it works

- **Fountain code (LT).** Frames are XORs of pseudorandom block subsets, so the
  receiver needs *any* slightly-more-than-k frames, in any order.
- **Self-describing frames** with a CRC-32, so a receiver can join mid-stream.
- **Container** with file name, media type, optional gzip and a SHA-256 that is
  verified before anything is offered.
