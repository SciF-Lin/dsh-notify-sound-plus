[简体中文](README.md) | **English**

# dsh-notify-sound-plus

An official-style notification plugin that adds a set of **alerts** to DeepSeek Harness.
Configure a sound and an optional system notification for each of four events — task completed / needs your answer / needs your approval / run failed — and get notified even while you are in another window. Works in both the web GUI and the desktop app.

![Plugin list](docs/plugin-list.png)

## What it does

* **System notifications** — sent when the model needs your answer, needs your approval, or completes the task; configurable in settings.
* **Pick it right in Settings** — choose per event whether to alert and which sound to use, with instant preview.
* **Use your own audio** — upload an mp3 / wav file as the alert sound.
* **Smart mode** — if the whale widget is already alerting for an event, this plugin stays quiet (events the widget does not cover are still handled here), so you never get a double alert.
* **One-click mute** — a speaker button next to the composer silences everything instantly.
* **Quiet by default** — sub-agent turns, your own aborts, and page reloads never replay old alerts.

## Settings

**General settings** — the entry row, where you pick the mode and open the detailed settings:

![The sound alert row in General settings](docs/settings-row.png)

**Detailed settings dialog** — per-event switches and sound pickers, volume, foreground policy, system notification, custom audio:

![Sound alert settings dialog](docs/settings-panel.png)

**Mute button at the bottom-left of the composer** — silences sound only, not system notifications:

![Mute button in the composer](docs/mute-button.png)

## The four alerts

|Event|Recommended sound|
|-|-|
|Task completed|Two descending tones — a crisp "ding-dong"|
|Needs your answer|Three ascending tones, like a question|
|Needs your approval|Three low tones, a knocking feel|
|Run failed|A low downward sweep — you know something broke|

Four more built-in tones — "ding-dong / bell / soft / alert" — are available per event.

## Installation

### 1. Install

Pick any of the three methods — **the first one is recommended** (installs straight from GitHub, no need to wait for an npm release):

```powershell
# ① Install directly from the GitHub repository (recommended)
dsh plugin --profile web add github:SciF-Lin/dsh-notify-sound-plus

# ② Install from the release package
dsh plugin --profile web add https://github.com/SciF-Lin/dsh-notify-sound-plus/releases/download/v2.0.0/dsh-notify-sound-plus-2.0.0.tgz

# ③ Install from npm
dsh plugin --profile web add dsh-notify-sound-plus
```

For the desktop app, swap `--profile web` for `--profile desktop`:

```powershell
dsh plugin --profile desktop add github:SciF-Lin/dsh-notify-sound-plus
```

**Another way**: paste one of the addresses above into an AI and ask it to install the plugin for you.

**Restart DSH** afterwards and it takes effect.

### 2. The row in General settings

Open **Settings → General** and you will see "Sound alerts":

* **Mode dropdown**:

  * `Alerts on` — every event alerts
  * `Alerts off` — no event alerts
  * `Smart` — coordinates with the whale widget (events it does not cover are still alerted here)
* **Play icon**: preview the sound.
* **Gear icon**: open the full settings dialog.

### 3. Full settings dialog (click the gear)

The layout matches the official DSH settings window. Three groups:

* **Alerts**: each event gets a switch + sound dropdown + preview button;
  a volume slider; and "Don't alert while in foreground" (alert only when running in the background).
* **System notification**: a single master switch (asks for notification permission when enabled).
  Once on, a system notification is sent when the model **needs your answer / needs your approval / completes the task**; failures stay silent to avoid noise.
  System notifications and sound are **two independent channels** — muting silences sound only, not notifications.
* **Custom audio**: upload your own audio (mp3 / wav / ogg / m4a, up to 2 MB each).

The repository address is shown at the bottom of the dialog.

### 4. Temporary mute

The speaker button at the bottom-left of the composer:

* Click once → alerts off
* Click again → alerts on

"Alerts" here refers to **sound** only: muting does not disable system notifications.

This switch **resets on restart**, so you cannot leave it off by accident.

## FAQ

**1. No sound at all?**

Check that sound is enabled in your browser or on the desktop app, that the mode is not `Alerts off`, and that the speaker button is not muted.

**2. Worried about duplicate alerts from other plugins?**

Set the mode to `Smart`.

**3. Can I use my own sound?**

Yes. In settings, click "Upload audio" and pick a file — mp3 / wav / ogg / m4a, up to 2 MB.

## License

MIT
