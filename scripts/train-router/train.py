"""
Fine-tune chinese-roberta-wwm-ext as a sequence-plan classifier.

Output label is a '→'-joined agent chain, e.g. "vision→file→slack".
Single-step intents are just a single token, e.g. "chat" or "vision".

Data format (data.jsonl, one JSON per line):
    {"text": "识别图片内容然后做成excel发给我", "label": "vision→file→slack"}
    {"text": "帮我看看这张图片", "label": "vision"}

Usage:
    pip install -r requirements.txt
    python train.py                          # train on data/data.jsonl, save to model/
    python train.py --data ./data/data.jsonl
    python train.py --epochs 15
"""

import argparse
import json
from pathlib import Path
from collections import Counter

import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
from sklearn.preprocessing import LabelEncoder
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from transformers import BertTokenizer, BertModel
import onnxruntime as ort

SCRIPT_DIR = Path(__file__).parent
# Base encoder weights — stored locally, no network needed at train time
LOCAL_MODEL = str(SCRIPT_DIR / "base-model")


# ── Dataset ─────────────────────────────────────────────────────────────────────

class PlanDataset(Dataset):
    def __init__(self, texts, labels, tokenizer, max_len=128):
        self.encodings = tokenizer(
            texts, truncation=True, padding=True,
            max_length=max_len, return_tensors="pt"
        )
        self.labels = torch.tensor(labels, dtype=torch.long)

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        return {k: v[idx] for k, v in self.encodings.items()}, self.labels[idx]


# ── Model ────────────────────────────────────────────────────────────────────────

class PlanClassifier(nn.Module):
    def __init__(self, encoder, num_labels):
        super().__init__()
        self.encoder = encoder
        hidden = encoder.config.hidden_size
        self.classifier = nn.Sequential(
            nn.Dropout(0.1),
            nn.Linear(hidden, num_labels),
        )

    def forward(self, input_ids, attention_mask, token_type_ids=None):
        out = self.encoder(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids,
        )
        # Use [CLS] token representation
        pooled = out.last_hidden_state[:, 0, :]
        return self.classifier(pooled)


# ── Data loading ─────────────────────────────────────────────────────────────────

def load_data(data_path: Path):
    texts, labels = [], []
    with open(data_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            texts.append(item["text"])
            labels.append(item["label"])
    counts = Counter(labels)
    return texts, labels, counts


# ── Training ──────────────────────────────────────────────────────────────────────

def train(data_path: Path, model_dir: Path, epochs: int, batch_size: int,
          num_workers: int = 0, base_model: str | None = None):
    texts, label_strs, counts = load_data(data_path)

    all_labels = sorted(counts.keys())
    le = LabelEncoder()
    le.fit(all_labels)
    labels = le.transform(label_strs).tolist()

    print(f"Loaded {len(texts)} samples across {len(all_labels)} plan classes:")
    for lbl in all_labels:
        print(f"  {lbl:40s} {counts[lbl]:3d} samples")

    X_train, X_val, y_train, y_val = train_test_split(
        texts, labels, test_size=0.20, random_state=42,
        stratify=labels if min(counts.values()) >= 2 else None,
    )
    print(f"\nTrain: {len(X_train)}  Val: {len(X_val)}")

    # Class weights: inverse frequency
    label_counts = Counter(y_train)
    total = sum(label_counts.values())
    class_weights = torch.tensor(
        [total / (len(all_labels) * max(label_counts.get(i, 1), 1)) for i in range(len(all_labels))],
        dtype=torch.float,
    )

    model_path = base_model if base_model else LOCAL_MODEL
    print(f"\nLoading encoder from: {model_path}")
    tokenizer = BertTokenizer.from_pretrained(model_path)
    encoder   = BertModel.from_pretrained(model_path)

    train_ds = PlanDataset(X_train, y_train, tokenizer)
    val_ds   = PlanDataset(X_val,   y_val,   tokenizer)
    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=num_workers, pin_memory=(num_workers > 0))
    val_dl   = DataLoader(val_ds,   batch_size=batch_size, num_workers=num_workers, pin_memory=(num_workers > 0))

    model = PlanClassifier(encoder, num_labels=len(all_labels))
    optimizer = torch.optim.AdamW([
        {"params": model.encoder.parameters(),    "lr": 2e-5},
        {"params": model.classifier.parameters(), "lr": 1e-3},
    ])
    criterion = nn.CrossEntropyLoss(weight=class_weights)

    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    print(f"Device: {device}\n")
    model.to(device)
    criterion = criterion.to(device)

    best_val_acc = 0.0
    best_state   = None

    for epoch in range(1, epochs + 1):
        model.train()
        total_loss = 0.0
        for batch, batch_labels in train_dl:
            batch        = {k: v.to(device) for k, v in batch.items()}
            batch_labels = batch_labels.to(device)
            optimizer.zero_grad()
            logits = model(**batch)
            loss   = criterion(logits, batch_labels)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        model.eval()
        all_preds, all_true = [], []
        with torch.no_grad():
            for batch, batch_labels in val_dl:
                batch  = {k: v.to(device) for k, v in batch.items()}
                logits = model(**batch)
                preds  = logits.argmax(dim=-1).cpu().tolist()
                all_preds.extend(preds)
                all_true.extend(batch_labels.tolist())

        val_acc = sum(p == t for p, t in zip(all_preds, all_true)) / len(all_true)

        from sklearn.metrics import f1_score
        f1_per_class = f1_score(all_true, all_preds, average=None, labels=list(range(len(all_labels))), zero_division=0)
        f1_str = "  ".join(f"{all_labels[i]}={f1_per_class[i]:.2f}" for i in range(len(all_labels)))
        print(f"Epoch {epoch:2d}/{epochs}  loss={total_loss/len(train_dl):.4f}  val_acc={val_acc:.3f}  [{f1_str}]")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state   = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    if best_state:
        model.load_state_dict(best_state)

    print(f"\nBest val acc: {best_val_acc:.3f} — re-evaluating best checkpoint...")
    model.eval()
    best_preds, best_true = [], []
    with torch.no_grad():
        for batch, batch_labels in val_dl:
            batch  = {k: v.to(device) for k, v in batch.items()}
            logits = model(**batch)
            preds  = logits.argmax(dim=-1).cpu().tolist()
            best_preds.extend(preds)
            best_true.extend(batch_labels.tolist())

    all_labels = list(range(len(le.classes_)))
    print(classification_report(best_true, best_preds, target_names=le.classes_, labels=all_labels, zero_division=0))

    # ── Export ───────────────────────────────────────────────────────────────────
    model_dir.mkdir(parents=True, exist_ok=True)

    with open(model_dir / "labels.json", "w") as f:
        json.dump(le.classes_.tolist(), f, ensure_ascii=False)

    tokenizer.save_pretrained(model_dir)

    model.eval().cpu()
    dummy = tokenizer(["测试"], return_tensors="pt", padding=True, truncation=True, max_length=128)
    with torch.no_grad():
        torch.onnx.export(
            model,
            (dummy["input_ids"], dummy["attention_mask"]),
            str(model_dir / "classifier.onnx"),
            input_names=["input_ids", "attention_mask"],
            output_names=["logits"],
            dynamic_axes={
                "input_ids":      {0: "batch", 1: "seq"},
                "attention_mask": {0: "batch", 1: "seq"},
                "logits":         {0: "batch"},
            },
            opset_version=12,
        )
    print(f"\nModel exported to {model_dir}/classifier.onnx")

    # Smoke test
    sess = ort.InferenceSession(str(model_dir / "classifier.onnx"))
    smoke = [
        ("识别图片内容然后做成excel表格发给我", "vision→file→slack"),
        ("帮我看看这张图片里有什么",            "vision"),
        ("把这张图识别出来存成文件",             "vision→file"),
        ("今天天气怎么样",                       "chat"),
        ("给 #general 发条消息",                 "slack"),
        ("帮我新建一个文件",                     "file"),
    ]
    print("\nSmoke tests:")
    all_pass = True
    for text, expected in smoke:
        enc    = tokenizer([text], return_tensors="np", padding=True, truncation=True, max_length=128)
        logits = sess.run(None, {"input_ids": enc["input_ids"], "attention_mask": enc["attention_mask"]})[0][0]
        probs  = np.exp(logits) / np.exp(logits).sum()
        pred   = le.classes_[int(np.argmax(probs))]
        conf   = float(probs.max())
        ok     = "✓" if pred == expected else "✗"
        if pred != expected:
            all_pass = False
        print(f"  {ok} {pred:40s} ({conf:.2f})  expected={expected:40s}  '{text}'")

    if not all_pass:
        print("\nWARNING: some smoke tests failed — add more training samples for those sequences.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data",       default=str(SCRIPT_DIR / "data" / "data.jsonl"))
    parser.add_argument("--model-dir",  default=str(SCRIPT_DIR / "model"))
    parser.add_argument("--epochs",     type=int, default=20)
    parser.add_argument("--batch-size",  type=int, default=16)
    parser.add_argument("--base-model", default=str(SCRIPT_DIR / "base-model"),
                        help="Path to pre-downloaded Chinese BERT model directory")
    parser.add_argument("--num-workers", type=int, default=0,
                        help="DataLoader worker processes; 4-8 recommended on Apple Silicon")
    args = parser.parse_args()

    train(Path(args.data), Path(args.model_dir), args.epochs, args.batch_size,
          args.num_workers, args.base_model)
