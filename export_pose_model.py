"""
Creates models/yolov8n-pose.onnx (OPTIONAL) - lets the distance measurement use
shoulders / torso / eyes / ears when you are too close for the whole body to fit.

Run ONCE on any normal PC, then copy the models/ folder next to app.py:

    pip install ultralytics onnx
    python export_pose_model.py

IMGSZ must match POSE_INPUT in distance.py (default 416).
"""
import os
from ultralytics import YOLO

IMGSZ = 416

model = YOLO("yolov8n-pose.pt")          # downloads the small pretrained model
exported = model.export(format="onnx", imgsz=IMGSZ, opset=12, simplify=False, dynamic=False)

os.makedirs("models", exist_ok=True)
dest = os.path.join("models", "yolov8n-pose.onnx")
os.replace(exported, dest)
print("Saved", dest)
