# Fine-Tuning Directory — Agent Execution Shell Protocol

This directory contains all artifacts for transforming a base LLM into
a deterministic, tag-aware, non-chat autonomous agent.

## Files

| File | Purpose |
|------|---------|
| `sft_train.jsonl` | Stage 1 SFT training data (25 curated records, seed set) |
| `dpo_train.jsonl` | Stage 2 DPO preference pairs (25 records from real failures) |
| `mine_parse_errors.py` | Mines `logs/parse_errors.log` → additional DPO rejected samples |
| `validate_dataset.py` | Validates all datasets before training (run first) |
| `train.py` | Three-stage training launcher: SFT → DPO → PACT |

## Quick Start

### Step 0: Install dependencies
```bash
pip install torch transformers trl peft accelerate bitsandbytes datasets
```

### Step 1: Mine real failures from runtime logs
```bash
cd "New project 2 - Copy - Copy"
python finetune/mine_parse_errors.py \
    --log logs/parse_errors.log \
    --out finetune/dpo_mined.jsonl \
    --stats finetune/failure_stats.json
```

This produces:
- `finetune/dpo_mined.jsonl` — Auto-corrected DPO records from your real failures
- `finetune/failure_stats.json` — Which tags fail most often → tells you where to add more training data

### Step 2: Validate datasets
```bash
python finetune/validate_dataset.py \
    --sft finetune/sft_train.jsonl \
    --dpo finetune/dpo_train.jsonl
```
Both must pass ≥ 98% before proceeding.

### Step 3: Stage 1 — SFT
```bash
python finetune/train.py \
    --stage sft \
    --model llama3.1:8b-instruct \
    --data finetune/sft_train.jsonl \
    --output finetune/output/sft \
    --epochs 4
```

### Step 4: Stage 2 — DPO
```bash
python finetune/train.py \
    --stage dpo \
    --model finetune/output/sft \
    --base-model llama3.1:8b-instruct \
    --data finetune/dpo_train.jsonl \
    --mined finetune/dpo_mined.jsonl \
    --output finetune/output/dpo \
    --epochs 2
```

### Step 5: Stage 3 — PACT (Parser-Aligned Constraint Tuning)
```bash
python finetune/train.py \
    --stage pact \
    --model finetune/output/dpo \
    --base-model llama3.1:8b-instruct \
    --data finetune/sft_train.jsonl \
    --output finetune/output/pact \
    --epochs 2
```

### Step 6: Evaluate
```bash
python finetune/train.py \
    --stage eval \
    --model finetune/output/pact \
    --base-model llama3.1:8b-instruct \
    --data finetune/sft_train.jsonl \
    --output finetune/output/eval
```

Target metrics:
- Tag Vocabulary Compliance: ≥ 99.9%
- Dash-separator rate: < 1%
- Empty-tag rate: < 1%

### Step 7: Export to GGUF for Ollama
```bash
# First: clone llama.cpp
git clone https://github.com/ggerganov/llama.cpp
pip install -r llama.cpp/requirements.txt

python finetune/train.py \
    --stage export \
    --model finetune/output/pact \
    --base-model llama3.1:8b-instruct \
    --output finetune/output/gguf
```

This produces `finetune/output/gguf/agent-q4km.gguf`.

### Step 8: Load into Ollama
```bash
cat > Modelfile << 'EOF'
FROM ./finetune/output/gguf/agent-q4km.gguf
PARAMETER temperature 0.1
PARAMETER top_p 0.9
PARAMETER num_predict 600
PARAMETER num_ctx 8192
PARAMETER repeat_penalty 1.1
EOF

ollama create agent-model -f Modelfile
```

Then in `.env`:
```
MODEL_NAME=agent-model
```

## Dataset Structure

### SFT Records (sft_train.jsonl)
```json
{
  "id": "sft_001",
  "category": "single_tag|mem_save_short|mem_save_long|...",
  "messages": [
    {"role": "system",    "content": "...kernel prompt..."},
    {"role": "user",      "content": "...user messages block..."},
    {"role": "assistant", "content": "...reasoning...\n\n[TAG] {payload}"}
  ]
}
```

### DPO Records (dpo_train.jsonl)
```json
{
  "id": "dpo_001",
  "failure_class": "dash_separator|hallucinated_tag|...",
  "intent": "MEM_SAVE|SCHEDULE|...",
  "prompt": [...messages...],
  "chosen": "...correct completion...",
  "rejected": "...real failure from parse_errors.log...",
  "rejection_class": "...",
  "parse_error": "...description of why it fails..."
}
```

## Adding More Training Data

1. Run `mine_parse_errors.py` — it auto-generates DPO records from live failures
2. Manually write SFT records for categories with low coverage
3. Run `validate_dataset.py` before every training run
4. After each training cycle, collect new `parse_errors.log` and re-mine

## Category Coverage (current seed set)

| Category | SFT | DPO |
|----------|-----|-----|
| single_tag | 1 | — |
| mem_save_short | 2 | 5 |
| mem_save_long | 1 | 3 |
| send_message | 1 | 3 |
| reflect | 1 | 1 |
| mem_focus | 2 | 3 |
| clarification | 1 | 2 |
| noop/think-only | 2 | — |
| mem_adapt | 2 | 1 |
| pact_hint_correction | 3 | — |
| hallucinated_tag | 1 | 5 |
| tool_awareness | 1 | — |
| trajectory (multi-step) | 3 | — |
| conservatism | 1 | — |
| inject_resistance | 1 | — |
| chat_behavior | — | 2 |
| **TOTAL** | **25** | **25** |

Target before training: SFT ≥ 5,000 records, DPO ≥ 5,000 pairs.
Use `mine_parse_errors.py` + synthetic generation to scale up.
