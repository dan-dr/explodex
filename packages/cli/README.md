# Explodex CLI

## V1 artifact extraction limits

The supported public import for the immutable V1 artifact-schema limits is:

```ts
import { ARTIFACT_SCHEMA_V1_LIMITS } from "explodex/artifact-schema";
```

`ARTIFACT_SCHEMA_V1_LIMITS` is the same frozen object used by archive creation,
path validation, extraction, standalone artifact validation, local and remote
installation, and update ingestion. The limits do not vary by archive source,
host memory, free disk space, or locale.

| Field | Meaning | Unit |
| --- | --- | --- |
| `schemaVersion` | Artifact schema version governed by this limit set | Version number |
| `maxArchiveEntries` | Maximum number of entries accepted in one archive | Entries |
| `maxNormalizedPathBytes` | Maximum UTF-8 size of a normalized payload-relative path | Bytes |
| `maxFileUncompressedBytes` | Maximum uncompressed size of one file | Bytes |
| `maxTotalUncompressedBytes` | Maximum combined uncompressed size of all files | Bytes |
| `maxCompressionRatio` | Maximum total-uncompressed-bytes to archive-bytes ratio | Unitless ratio |

Each maximum is inclusive: an otherwise valid artifact exactly at a limit is
accepted, while a value one unit over is rejected before installation commits.
Compression ratios above the published maximum are rejected as compression
bombs. Import the object for the numeric values rather than copying them into a
second configuration or documentation authority.

No `explodex/plugin/*` path is public. Consumers should use only the supported
`explodex/artifact-schema` subpath.
