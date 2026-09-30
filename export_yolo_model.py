"""
Creates models/yolov8n.onnx for the camera-only distance measurement.

Run this ONCE on any normal PC (Windows / Mac / Linux), then copy the
models/ folder to the Raspberry Pi next to app.py:

    pip install ultralytics onnx
    python export_yolo_model.py

IMGSZ here must match YOLO_INPUT in distance.py (default 416).
Lower it to 320 for more speed, raise it to 640 for a bit more accuracy
(then change YOLO_INPUT in distance.py to the same number).
"""
import os
from ultralytics import YOLO

IMGSZ = 416

model = YOLO("yolov8n.pt")          # downloads the small pretrained model
exported = model.export(format="onnx", imgsz=IMGSZ, opset=12, simplify=False, dynamic=False)

os.makedirs("models", exist_ok=True)
dest = os.path.join("models", "yolov8n.onnx")
os.replace(exported, dest)
print("Saved", dest)
