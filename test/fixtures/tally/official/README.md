# Optional official Tally examples

Run `python3 tools/prepare-resources.py --fetch --tests` from the repository root. The setup stores these publisher-sourced files locally; source control excludes them.

| Local file | Public source | Verified SHA-256 |
| --- | --- | --- |
| `Integration_Demo_Samples.zip` | [Tally integration examples](https://help.tallysolutions.com/wp-content/uploads/2025/07/Integration_Demo_Samples.zip) | `0999ec4ebdf13f163e5df18cdfb410847f045d7a8b11ef34290c05f5e754a89f` |
| `TallyHelp-invoice-mode.xml` | [TallyHelp Sample XML](https://help.tallysolutions.com/sample-xml/) | `78c57c039080889cd74cd6c980f338e2d53bee24972c07bb46e8fb0dd3930c4d` |

The integration ZIP stays byte-for-byte unchanged. The invoice fixture is selected from the public page's XML envelopes by its pinned normalized hash. The extractor decodes HTML entities, replaces typographic double quotes and nonbreaking spaces, trims text at element boundaries, sorts attributes and emits compact UTF-8 XML with one final newline. Values and element order stay unchanged. The source page's surrounding HTML can change; a changed invoice fails the output hash and is not installed.

These are public publisher examples with publisher metadata and sample business identifiers. They are distinct from the independently authored synthetic XML in the parent directory. The project licence does not cover these downloaded examples, and their public availability is not treated as permission to redistribute them in the source repository.
