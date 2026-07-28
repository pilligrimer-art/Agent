#!/usr/bin/env python3
"""
train.py — Fine-tuning launcher for the agent execution shell model.

Pipeline: Stage 1 SFT → Stage 2 DPO → Stage 3 PACT
Supports: QLoRA (recommended) or full fine-tune

Usage:
    # Stage 1 — SFT
    python finetune/train.py --stage sft --model llama3.1:8b-instruct \
        --data finetune/sft_train.jsonl --output finetune/output/sft

    # Stage 2 — DPO (starts from SFT adapter)
    python finetune/train.py --stage dpo \
        --model finetune/output/sft \
        --data finetune/dpo_train.jsonl \
        --mined finetune/dpo_mined.jsonl \
        --output finetune/output/dpo

    # Stage 3 — PACT (starts from DPO adapter)
    python finetune/train.py --stage pact \
        --model finetune/output/dpo \
        --data finetune/sft_train.jsonl \
        --filter-category pact \
        --output finetune/output/pact

Requirements:
    pip install torch transformers trl peft accelerate bitsandbytes datasets
"""

import argparse
import json
import sys
import os
from pathlib import Path


# ─── Dependency check ────────────────────────────────────────────────────────────

def check_dependencies():
    missing = []
    for pkg in ["torch", "transformers", "trl", "peft", "accelerate", "bitsandbytes", "datasets"]:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        print(f"Missing dependencies: {', '.join(missing)}")
        print(f"Install with: pip install {' '.join(missing)}")
        sys.exit(1)


# ─── Model resolution ─────────────────────────────────────────────────────────────

HF_MODEL_MAP = {
    # Map friendly names to HuggingFace model IDs
    "llama3.1:8b-instruct": "meta-llama/Meta-Llama-3.1-8B-Instruct",
    "llama3.1:8b":          "meta-llama/Meta-Llama-3.1-8B-Instruct",
    "gemma3:4b":            "google/gemma-3-4b-it",
    "gemma3:12b":           "google/gemma-3-12b-it",
    "mistral:7b":           "mistralai/Mistral-7B-Instruct-v0.3",
    "phi3.5-mini":          "microsoft/Phi-3.5-mini-instruct",
}

def resolve_model(model_name: str) -> str:
    if Path(model_name).exists():
        return model_name  # Local path (adapter or merged model)
    return HF_MODEL_MAP.get(model_name, model_name)


# ─── Dataset loaders ─────────────────────────────────────────────────────────────

def load_sft_dataset(paths: list[str], filter_category: str | None = None):
    """Load SFT JSONL files and return a HuggingFace Dataset."""
    from datasets import Dataset
    
    records = []
    for path in paths:
        p = Path(path)
        if not p.exists():
            print(f"WARNING: {path} not found, skipping")
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                if filter_category and record.get("category", "") != filter_category:
                    if not record.get("category", "").startswith(filter_category):
                        continue
                records.append(record)
    
    print(f"Loaded {len(records)} SFT records")
    return Dataset.from_list(records)


def load_dpo_dataset(paths: list[str]):
    """Load DPO JSONL files (chosen/rejected format) and return a HuggingFace Dataset."""
    from datasets import Dataset
    
    records = []
    for path in paths:
        p = Path(path)
        if not p.exists():
            print(f"WARNING: {path} not found, skipping")
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                # Validate required DPO fields
                if "chosen" not in record or "rejected" not in record:
                    print(f"WARNING: Record {record.get('id')} missing chosen/rejected, skipping")
                    continue
                # Build prompt string from messages list if present
                if "prompt" in record and isinstance(record["prompt"], list):
                    record["prompt"] = format_chat_prompt(record["prompt"])
                records.append(record)
    
    print(f"Loaded {len(records)} DPO records")
    return Dataset.from_list(records)


def format_chat_prompt(messages: list[dict]) -> str:
    """Format a list of chat messages into a single prompt string."""
    parts = []
    for msg in messages:
        role = msg["role"]
        content = msg["content"]
        if role == "system":
            parts.append(f"<|system|>\n{content}\n<|end|>")
        elif role == "user":
            parts.append(f"<|user|>\n{content}\n<|end|>")
    parts.append("<|assistant|>")
    return "\n".join(parts)


# ─── QLoRA config ────────────────────────────────────────────────────────────────

def get_lora_config():
    from peft import LoraConfig, TaskType
    return LoraConfig(
        r=64,
        lora_alpha=128,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj"
        ],
        lora_dropout=0.05,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
    )


def get_bnb_config():
    import torch
    from transformers import BitsAndBytesConfig
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )


# ─── Stage 1: SFT ────────────────────────────────────────────────────────────────

def run_sft(args):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
    from trl import SFTTrainer, DataCollatorForCompletionOnlyLM
    from peft import get_peft_model, prepare_model_for_kbit_training

    model_id = resolve_model(args.model)
    print(f"[SFT] Loading model: {model_id}")

    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    bnb_config = get_bnb_config()
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
        attn_implementation="flash_attention_2" if torch.cuda.is_available() else "eager",
    )
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, get_lora_config())
    model.print_trainable_parameters()

    # Load dataset
    data_paths = [args.data]
    dataset = load_sft_dataset(data_paths, filter_category=args.filter_category)

    def format_record(record):
        """Format a chat record into a single training string."""
        messages = record.get("messages", [])
        parts = []
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            if role == "system":
                parts.append(f"<|system|>\n{content}\n<|end|>")
            elif role == "user":
                parts.append(f"<|user|>\n{content}\n<|end|>")
            elif role == "assistant":
                parts.append(f"<|assistant|>\n{content}\n<|end|>")
        return {"text": "\n".join(parts)}

    dataset = dataset.map(format_record)

    output_dir = args.output
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=8,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        weight_decay=0.01,
        bf16=torch.cuda.is_available(),
        fp16=False,
        gradient_checkpointing=True,
        logging_steps=10,
        save_steps=200,
        eval_strategy="no",
        dataloader_num_workers=2,
        report_to="none",
        # CRITICAL: do NOT pack sequences
        # Packing can cause tag patterns from one sample to contaminate another
        # This teaches the model that tags can appear in the wrong positions
        group_by_length=False,
    )

    # Response-only training: only compute loss on assistant tokens
    response_template = "<|assistant|>"
    collator = DataCollatorForCompletionOnlyLM(
        response_template=response_template,
        tokenizer=tokenizer,
    )

    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=dataset,
        data_collator=collator,
        tokenizer=tokenizer,
        max_seq_length=2048,
        dataset_text_field="text",
        packing=False,  # CRITICAL: never pack for agent training
    )

    print(f"[SFT] Starting training on {len(dataset)} records...")
    trainer.train()
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)
    print(f"[SFT] Saved adapter to {output_dir}")


# ─── Stage 2: DPO ────────────────────────────────────────────────────────────────

def run_dpo(args):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
    from trl import DPOTrainer, DPOConfig
    from peft import PeftModel

    model_id = resolve_model(args.model)
    print(f"[DPO] Loading model from: {model_id}")

    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    bnb_config = get_bnb_config()
    base_model_id = resolve_model(args.base_model or "llama3.1:8b-instruct")

    model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
    )
    # Load the SFT adapter as the starting point
    if Path(model_id).exists() and Path(model_id).is_dir():
        model = PeftModel.from_pretrained(model, model_id)

    # Reference model (frozen, for KL divergence)
    ref_model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
    )

    # Load DPO dataset — merge curated and mined records
    dpo_paths = [args.data]
    if args.mined and Path(args.mined).exists():
        dpo_paths.append(args.mined)
    dataset = load_dpo_dataset(dpo_paths)

    output_dir = args.output
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    dpo_config = DPOConfig(
        output_dir=output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=max(1, args.batch_size // 2),
        gradient_accumulation_steps=16,
        learning_rate=5e-5,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=torch.cuda.is_available(),
        logging_steps=10,
        save_steps=100,
        report_to="none",
        # DPO beta: lower = stronger adherence to reference model
        # 0.1 is appropriate for syntax-critical fine-tuning
        # Lower values reduce risk of catastrophic forgetting
        beta=0.1,
        max_length=2048,
        max_prompt_length=1536,
    )

    trainer = DPOTrainer(
        model=model,
        ref_model=ref_model,
        args=dpo_config,
        train_dataset=dataset,
        tokenizer=tokenizer,
    )

    print(f"[DPO] Starting training on {len(dataset)} preference pairs...")
    trainer.train()
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)
    print(f"[DPO] Saved adapter to {output_dir}")


# ─── Stage 3: PACT (Parser-Aligned Constraint Tuning) ───────────────────────────

def run_pact(args):
    """PACT reuses the SFT trainer but filters to pact-category records only."""
    print("[PACT] Stage 3 — Parser-Aligned Constraint Tuning")
    print("[PACT] Filtering training data to PACT categories...")
    # PACT uses the SFT trainer with category filter
    args.filter_category = "pact"
    args.epochs = min(args.epochs, 2)  # PACT is short — 1-2 epochs only
    run_sft(args)


# ─── Evaluation ──────────────────────────────────────────────────────────────────

def run_eval(args):
    """
    Run the parse success rate evaluation on a trained model.
    
    This loads the trained adapter, runs it against the eval set,
    and reports tag compliance metrics.
    """
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline
    from peft import PeftModel
    
    print(f"[EVAL] Loading model from {args.model}")
    
    base_model_id = resolve_model(args.base_model or "llama3.1:8b-instruct")
    tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=True)
    
    model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        device_map="auto",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    if Path(args.model).exists():
        model = PeftModel.from_pretrained(model, args.model)
        model = model.merge_and_unload()

    gen = pipeline("text-generation", model=model, tokenizer=tokenizer,
                   max_new_tokens=600, temperature=0.1, do_sample=True,
                   pad_token_id=tokenizer.eos_token_id)
    
    # Load eval set
    eval_path = Path(args.data)
    records = []
    with open(eval_path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                records.append(json.loads(line))
    
    REGISTERED_TAGS = {
        "MEM_SAVE", "MEM_DELETE", "MEM_FOCUS", "MEM_ADAPT",
        "MEM_ADAPT_CHALLENGE", "MEM_ADAPT_WEAKEN",
        "SCHEDULE", "REFLECT", "SEND_MESSAGE", "HELP_ACTION", "HELP_ACTIONS"
    }
    
    results = []
    for record in records:
        messages = record.get("messages", [])
        # Format prompt (exclude last assistant turn — that's what we predict)
        prompt_messages = [m for m in messages if m["role"] != "assistant"]
        prompt_parts = []
        for msg in prompt_messages:
            if msg["role"] == "system":
                prompt_parts.append(f"<|system|>\n{msg['content']}\n<|end|>")
            elif msg["role"] == "user":
                prompt_parts.append(f"<|user|>\n{msg['content']}\n<|end|>")
        prompt_parts.append("<|assistant|>")
        prompt = "\n".join(prompt_parts)
        
        output = gen(prompt)[0]["generated_text"][len(prompt):]
        
        # Check tag vocabulary compliance
        found_tags = set(re.findall(r'\[([A-Z_]+)[\s\]]', output))
        unknown_tags = found_tags - REGISTERED_TAGS
        
        # Check for common malformed patterns
        dash_pattern = bool(re.search(r'\[[A-Z_]+\]\s+[–-]', output))
        empty_tag = bool(re.search(r'\[[A-Z_]+\]\s*$', output, re.MULTILINE))
        
        results.append({
            "id": record.get("id"),
            "category": record.get("category"),
            "tvc": len(unknown_tags) == 0,
            "unknown_tags": list(unknown_tags),
            "dash_pattern": dash_pattern,
            "empty_tag_pattern": empty_tag,
            "output_preview": output[:200],
        })
    
    # Compute metrics
    n = len(results)
    tvc_rate = sum(r["tvc"] for r in results) / n
    dash_rate = sum(r["dash_pattern"] for r in results) / n
    empty_rate = sum(r["empty_tag_pattern"] for r in results) / n
    
    print(f"\n{'='*50}")
    print(f"EVAL RESULTS ({n} records)")
    print(f"{'='*50}")
    print(f"  Tag Vocabulary Compliance: {tvc_rate*100:.1f}%  (target: 99.9%)")
    print(f"  Dash-separator rate:       {dash_rate*100:.1f}%  (target: <1%)")
    print(f"  Empty-tag rate:            {empty_rate*100:.1f}%  (target: <1%)")
    
    if args.output:
        out = Path(args.output) / "eval_results.json"
        with open(out, "w") as f:
            json.dump({"metrics": {
                "tvc": tvc_rate,
                "dash_rate": dash_rate,
                "empty_rate": empty_rate,
            }, "records": results}, f, indent=2)
        print(f"  Full results: {out}")


# ─── Export to GGUF (for Ollama) ─────────────────────────────────────────────────

def run_export(args):
    """
    Merge LoRA adapter into base model and export to GGUF format for Ollama.
    
    Requires llama.cpp to be installed separately:
        git clone https://github.com/ggerganov/llama.cpp
        pip install -r llama.cpp/requirements.txt
    """
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    base_model_id = resolve_model(args.base_model or "llama3.1:8b-instruct")
    adapter_path = args.model
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    merged_path = output_dir / "merged"

    print(f"[EXPORT] Loading base model: {base_model_id}")
    tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        torch_dtype=torch.bfloat16,
        device_map="cpu",
        trust_remote_code=True,
    )

    print(f"[EXPORT] Loading adapter: {adapter_path}")
    model = PeftModel.from_pretrained(model, adapter_path)

    print("[EXPORT] Merging adapter into base model...")
    model = model.merge_and_unload()
    model.save_pretrained(merged_path)
    tokenizer.save_pretrained(merged_path)
    print(f"[EXPORT] Merged model saved to {merged_path}")

    # GGUF conversion (requires llama.cpp in PATH or adjacent)
    gguf_path = output_dir / "agent-q4km.gguf"
    llama_cpp_path = Path(os.environ.get("LLAMA_CPP_PATH", "../llama.cpp"))
    convert_script = llama_cpp_path / "convert_hf_to_gguf.py"

    if convert_script.exists():
        print(f"[EXPORT] Converting to GGUF (Q4_K_M)...")
        import subprocess
        result = subprocess.run([
            sys.executable, str(convert_script),
            str(merged_path),
            "--outtype", "q4_k_m",
            "--outfile", str(gguf_path),
        ], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"[EXPORT] GGUF written to {gguf_path}")
            print(f"\nTo load in Ollama:")
            print(f'  Create a Modelfile with: FROM {gguf_path}')
            print(f'  Run: ollama create agent-model -f Modelfile')
        else:
            print(f"[EXPORT] GGUF conversion failed: {result.stderr}")
            print(f"Manually run: python {convert_script} {merged_path} --outtype q4_k_m --outfile {gguf_path}")
    else:
        print(f"[EXPORT] llama.cpp not found at {llama_cpp_path}")
        print(f"[EXPORT] Merged HuggingFace model saved to {merged_path}")
        print(f"To convert manually:")
        print(f"  git clone https://github.com/ggerganov/llama.cpp")
        print(f"  python llama.cpp/convert_hf_to_gguf.py {merged_path} --outtype q4_k_m --outfile {gguf_path}")


# ─── CLI ─────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Agent execution shell fine-tuning pipeline"
    )
    parser.add_argument("--stage", required=True,
                        choices=["sft", "dpo", "pact", "eval", "export"],
                        help="Training stage to run")
    parser.add_argument("--model", required=True,
                        help="Model name (e.g. llama3.1:8b-instruct) or local adapter path")
    parser.add_argument("--base-model",
                        help="Base model ID (for DPO/export — if model is an adapter)")
    parser.add_argument("--data", required=True,
                        help="Path to training data JSONL")
    parser.add_argument("--mined",
                        help="[DPO only] Path to mined DPO records from parse_errors.log")
    parser.add_argument("--output", default="finetune/output",
                        help="Output directory for adapter/model")
    parser.add_argument("--epochs", type=int, default=3,
                        help="Number of training epochs")
    parser.add_argument("--batch-size", type=int, default=4,
                        help="Per-device batch size")
    parser.add_argument("--filter-category",
                        help="[SFT only] Filter dataset to this category prefix")

    args = parser.parse_args()
    check_dependencies()

    if args.stage == "sft":
        run_sft(args)
    elif args.stage == "dpo":
        run_dpo(args)
    elif args.stage == "pact":
        run_pact(args)
    elif args.stage == "eval":
        run_eval(args)
    elif args.stage == "export":
        run_export(args)


if __name__ == "__main__":
    main()
