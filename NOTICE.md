# Notices and Attribution

## Project

Cairn Notes is an independent personal learning archive maintained by JasonBuildAI. It is not official documentation for any upstream project.

## License map

| Material | License |
| --- | --- |
| Pi and OpenSandbox learning notes | CC BY-SA 4.0 |
| Engineering notes under `src/content/docs/engineering/` | CC BY-NC-SA 4.0 |
| Website code, build scripts and configuration | MIT |
| Third-party source code, documentation, names and trademarks | Their respective licenses |

See [CONTENT-LICENSE.md](CONTENT-LICENSE.md) and [LICENSE](LICENSE).

The repository contains content under both CC BY-SA 4.0 and CC BY-NC-SA 4.0. A redistribution of the complete content set must satisfy both licenses. In particular, the engineering notes must not be used commercially without separate permission from the relevant rights holders.

## Upstream projects

### Pi

- Upstream: <https://github.com/earendil-works/pi>
- Learned version: v1.3.0
- Commit: `71023aec1546d6d677a65669c5665c0927ce0dd0`
- Upstream license: MIT
- Copyright: Copyright (c) 2025 Mario Zechner
- Full text: [LICENSES/PI-MIT.txt](LICENSES/PI-MIT.txt)

Cairn Notes discusses Pi's architecture and includes short API usage examples and commentary. No complete Pi source tree is redistributed in this repository.

### OpenSandbox

- Upstream: <https://github.com/opensandbox-group/OpenSandbox>
- Learned version: release-1.1.1
- Commit: `531700ca18a7fa5fab6a2f25d6dc68a76eddab12`
- Upstream license: Apache License 2.0
- Full text: [LICENSES/OPENSANDBOX-APACHE-2.0.txt](LICENSES/OPENSANDBOX-APACHE-2.0.txt)

Cairn Notes discusses OpenSandbox's architecture and includes short API usage examples and commentary. No complete OpenSandbox source tree, release archive, or `.git` directory is redistributed in this repository.

### EasyVibe

- Upstream: <https://github.com/DatawhaleChina/easy-vibe>
- Course: <https://datawhalechina.github.io/easy-vibe/zh-cn/>
- Reviewed revision: `f2239c67052b6ad9ae3e72bc6b7a76f3c903cf64` (2026-10-22)
- Upstream license: CC BY-NC-SA 4.0, as stated in the upstream README at that revision
- Copyright: Datawhale and EasyVibe contributors
- License details: <https://creativecommons.org/licenses/by-nc-sa/4.0/>
- Local license text: [LICENSES/CC-BY-NC-SA-4.0.txt](LICENSES/CC-BY-NC-SA-4.0.txt)

The pages under `src/content/docs/engineering/` are an independent adaptation of EasyVibe's appendix chapters 1 through 9, covering 104 upstream Markdown files at the reviewed revision. Chapter 1 was condensed into one overview page. The remaining material was merged, reorganized, supplemented, and rewritten along a general software engineering path. Model, retrieval, and agent systems are treated as a specialized engineering chapter rather than a separate set of principles.

Interactive demos, animations, product surveys and repeated command tutorials were removed. Static tables, ASCII diagrams and new examples were written for these notes. A later overview page, "From Requirements to Reliable Operation," synthesizes the notes with an original running example. No upstream images, animations, interactive components or complete course pages are redistributed here.

Recommended attribution:

> Cairn Notes, adapted from EasyVibe by Datawhale / EasyVibe contributors, CC BY-NC-SA 4.0, changes made.

## Source code and archives

This repository intentionally excludes:

- upstream source code checkouts;
- release `.zip`, `.tar` and similar archives;
- local environment snapshots;
- private configuration and credentials.

Readers who want to run the experiments should obtain upstream source from the official repositories at the pinned versions above.

## Code excerpts

Short code excerpts are included for commentary, API illustration and discussion of failure boundaries. The notes' original prose and original examples are licensed under the license that applies to their section. Any code copied from an upstream project remains under that project's license and copyright.

## Trademarks and affiliation

Project names, product names and trademarks belong to their respective owners. Their use here is descriptive and does not imply endorsement, sponsorship, or official affiliation.

## Corrections and takedown requests

If you believe a fact is wrong, attribution is missing, or a passage exceeds reasonable quotation, please open an issue at:

<https://github.com/JasonBuildAI/cairn-notes/issues>

Reasonable requests will be reviewed, and content will be corrected, attributed, or removed as appropriate.
