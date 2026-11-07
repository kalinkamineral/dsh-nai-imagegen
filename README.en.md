# dsh-nai-imagegen

English · [简体中文](README.md)

[![verify](https://github.com/kalinkamineral/dsh-nai-imagegen/actions/workflows/verify.yml/badge.svg)](https://github.com/kalinkamineral/dsh-nai-imagegen/actions/workflows/verify.yml) [![release](https://img.shields.io/github/v/release/kalinkamineral/dsh-nai-imagegen)](https://github.com/kalinkamineral/dsh-nai-imagegen/releases)

A NovelAI image-generation plugin for **DeepSeek Harness (DSH)**: a sidebar panel plus a set of `nai_*` tools that the agent calls directly.

> Unofficial project. You bring your own NovelAI persistent token (or a relay that forwards to NovelAI).

## Features

- **Text to image**: Danbooru tags, `<image>` blocks, or `nai5-comic` pages; size, steps, model, sampler, seed, multiple samples
- **Image to image / inpaint**: base images are restricted to a dedicated input folder, with format / dimension / byte checks
- **Director tools**: lineart, sketch, colorize, emotion, declutter (no Anlas)
- **Character library (DNA)**: fixed features, alternate outfits, keywords, reference pictures; "rewrite features with a prompt"
- **Artist strings**: import an index, search, preview, temporary override
- **Prompt writer**: turns a sentence or a reference image into a structured NovelAI prompt using the model configured in DSH
- **Key pool**: several keys render concurrently; 401/403 disables a key, 429/5xx cools it down and retries elsewhere
- **DSH Go (Android)**: native tool cards, a balance strip above the composer, and a native panel
- **Debug log**: writer, render and connectivity calls are recorded (including TTFB and downloaded bytes)

## Download

- **Friend bundle** (no token, no artist strings, no character data): the `dsh-nai-imagegen-friend-*.zip` file on the [latest release](https://github.com/kalinkamineral/dsh-nai-imagegen/releases/latest)
- Developers: clone the repository and install as below.

## Install

### Desktop DSH

```sh
git clone https://github.com/kalinkamineral/dsh-nai-imagegen.git
dsh plugin --profile desktop add "<absolute path of the clone>"
```

Then restart DSH. See [README-install.md](README-install.md) for the full guide (Chinese).

### DSH Go (Android)

Copy the repository into the phone's local engine at `/root/.dsh/dsh-go/plugins/`, then:

```sh
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-nai-imagegen
```

## Configuration

Sidebar → NovelAI → Settings → Connection:

| Field | Notes |
| --- | --- |
| API base | Official `https://image.novelai.net`, or your relay URL |
| Token | NovelAI persistent token (`pst-…`) |
| Decode | `json` (default) / `zip` (smallest transfer) / `auto` (sniff the response) |
| Proxy | blank = direct; `auto` = system proxy; or an explicit URL such as `http://127.0.0.1:7890` |

The agent can change the same settings with `nai_config`, or you can edit `$DSH_HOME/nai-imagegen/config.json` directly.

## Tools

| Tool | Purpose |
| --- | --- |
| `nai_generate` | text to image |
| `nai_img2img` | image to image |
| `nai_inpaint` | inpainting |
| `nai_director` | director-tool post-processing |
| `nai_estimate` | cost estimate before rendering |
| `nai_lookup` / `nai_resolve` | library search / character roster resolution |
| `nai_index` | rebuild the five-library index |
| `nai_status` | plugin status |
| `nai_probe` | connectivity and subscription probe (free) |
| `nai_keys` | key-pool management |
| `nai_artists` | artist strings |
| `nai_character_edit` | rewrite character features with a prompt |
| `nai_doctor` | capability self-check |
| `nai_config` | change configuration |

## Layout

```
index.js          host half: tools and HTTP API
client.js         browser half: sidebar panel (prebuilt by hand)
lib/              networking, config, characters, artist strings, DSH Go views
tests/verify.mjs  offline test suite (no network, no renders)
DESIGN.md         panel design language and tokens
config.example.json
```

## Development

```sh
node tests/verify.mjs   # 47 offline checks
```

No runtime dependencies; Node.js 22.19+ is enough. Restart DSH after host-code changes; a page refresh is enough for client-only changes.

## License

[MIT](LICENSE)
