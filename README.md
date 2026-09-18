# Perimeter — PIR Motion Watch (Webcam Edition)

A motion-triggered capture system for the Raspberry Pi: a PIR sensor
watches for movement, a USB webcam takes the picture, and a small web
dashboard shows what's happening in real time from any device on your
network.

This is the webcam version of the Figure 3.1 setup — same PIR wiring,
but a USB webcam (via OpenCV) replaces the Raspberry Pi Camera Module.

## What's included

```
motion-system/
├── app.py                 # Flask server: sensor loop + capture + API
├── requirements.txt
├── templates/
│   └── index.html         # Dashboard page
├── static/
│   ├── style.css           # Dashboard styling
│   └── app.js               # Dashboard live-update logic
└── captures/               # Saved motion snapshots (created automatically)
```

## 1. Wiring (unchanged from the PIR-only setup)

| PIR pin | Connects to             |
|---------|--------------------------|
| VCC     | 5V (physical pin 2 or 4) |
| GND     | Ground (e.g. pin 6)      |
| OUT     | GPIO 4 (physical pin 7)  |

Plug the USB webcam into any USB port on the Pi — no GPIO wiring needed
for it.

If you use a different GPIO pin for OUT, change `PIR_PIN` at the top
of `app.py`.

## 2. Install dependencies on the Raspberry Pi

```bash
sudo apt update
sudo apt install python3-opencv python3-pip
pip install -r requirements.txt --break-system-packages
```

## 3. Run it

```bash
python3 app.py
```

Then, from any device on the same Wi-Fi network, open:

```
http://<raspberry-pi-ip-address>:5000
```

(Find the Pi's IP with `hostname -I` on the Pi itself.)

## 4. Using the dashboard

- **Live panel** — shows the most recent capture, with a timestamp and
  filename underneath.
- **ARMED / DISARMED toggle** — top right. While disarmed, motion is
  ignored and nothing is captured.
- **Event log** — every motion trigger, most recent first.
- **Module status** — shows whether the PIR sensor and webcam
  initialised correctly.

## 5. Testing without a Raspberry Pi

The app can run in simulation mode on a regular laptop, with no GPIO
pins or real camera required — useful for testing the dashboard itself:

```bash
MOTION_SIM=1 python3 app.py
```

This generates a fake motion event every so often and writes a
placeholder image, so you can see the full flow working end to end.

## Configuration

All of the following are set near the top of `app.py`:

| Setting               | Default | Meaning                                      |
|------------------------|---------|-----------------------------------------------|
| `PIR_PIN`              | `4`     | BCM GPIO pin wired to the sensor's OUT pin    |
| `CAMERA_INDEX`         | `0`     | Which webcam to use (`0` = first one found)   |
| `COOLDOWN_SECONDS`     | `5`     | Minimum gap between two triggered captures    |
| `EVENT_HISTORY_LIMIT`  | `100`   | How many past events are kept in memory       |
| `SENSOR_WARMUP_SECONDS`| `2`     | Settle time after the sensor powers on        |

## Notes

- Captured images are saved in `captures/` as
  `motion_YYYYMMDD_HHMMSS.jpg`.
- The dashboard polls the server once per second — no page refresh
  needed.
- This uses Flask's built-in development server, which is fine for a
  lab/home setup on a local network. For anything exposed beyond your
  LAN, put it behind a proper WSGI server (e.g. gunicorn) first.
