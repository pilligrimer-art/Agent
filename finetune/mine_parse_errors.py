#!/usr/bin/env python3
"""
mine_parse_errors.py — Convert parse_errors.log into DPO rejected samples.

Usage:
    python finetune/mine_parse_errors.py \
        --log logs/parse_errors.log \
        --out finetune/dpo_mined.jsonl \
        --stats finetune/failure_stats.json

This script reads the real runtime parse failures logged by output_parser.js
and converts them into DPO rejected samples ready for Stage 2 training.

Each mined record has:
  - The real malformed string the model actually produced (rejected)
  - The correct canonical form (chosen) derived by pattern correction
  - A failure_class label for training prioritization
"""

import json
import re
import sys
import argparse
from collections import Counter, defaultdict
from pathlib import Path
from datetime import datetime


# ─── Canonical correction rules ────────────────────────────────────────────────

DASH_SEPARATOR_CORRECTIONS = {
    # [TAG] – "prose"  →  [TAG] {"text":"prose","why":"..."}
    "SEND_MESSAGE": lambda prose: f'[SEND_MESSAGE] {{"text":"{prose}","why":"Corrected from dash-separator format."}}',
    # [MEM_SAVE] – "prose"  →  [MEM_SAVE short] {"type":"thought","content":"prose","priority":"normal","why":"..."}
    "MEM_SAVE":     lambda prose: f'[MEM_SAVE short] {{"type":"thought","content":"{prose}","priority":"normal","why":"Corrected from dash-separator format."}}',
    # [SCHEDULE] – "prose"  →  [SCHEDULE 60]
    "SCHEDULE":     lambda _:     '[SCHEDULE 60]',
    # [MEM_ADAPT] – "prose"  →  [MEM_ADAPT] {"type":"reframe","target":"...","rule":"prose","why":"..."}
    "MEM_ADAPT":    lambda prose: f'[MEM_ADAPT] {{"type":"reframe","target":"behavior","rule":"{prose}","why":"Corrected from dash-separator format."}}',
    # [REFLECT] prose  →  [REFLECT]
    "REFLECT":      lambda _:     '[REFLECT]',
}

ID_IN_SAVE_CORRECTIONS = {
    # [MEM_SAVE #ID | type]  →  [MEM_FOCUS #ID]  (wrong tag for reading)
    "MEM_SAVE": lambda tag_id: f'[MEM_FOCUS #{tag_id}]',
}

EMPTY_TAG_CORRECTIONS = {
    # [TAG]  →  [HELP_ACTION "TAG"]  (model doesn't know syntax)
    "MEM_SAVE": '[HELP_ACTION "MEM_SAVE"]',
    "MEM_FOCUS": '[HELP_ACTION "MEM_FOCUS"]',
    "SCHEDULE": '[SCHEDULE 60]',
}

SCHEDULE_MALFORMED_CORRECTIONS = {
    # [SCHEDULE] Schedule next cycle: 20 seconds  →  [SCHEDULE 20]
    "SCHEDULE": lambda s: re.sub(
        r'\[SCHEDULE\]\s*(?:Schedule next cycle\s*(?:in|:)?\s*)?(\d+)\s*(?:seconds?)?',
        lambda m: f'[SCHEDULE {m.group(1)}]',
        s
    ) if re.search(r'\d+', s) else '[SCHEDULE 60]'
}


# ─── Pattern matchers ───────────────────────────────────────────────────────────

def classify_event(line: str) -> dict | None:
    """Parse a single parse_errors.log line into a structured event."""
    
    # Structured JSON events (newer format)
    json_match = re.match(
        r'\[(.+?)\] \[parser\.(\w+)\] (\{.+\})',
        line
    )
    if json_match:
        ts, event_type, payload_str = json_match.groups()
        try:
            payload = json.loads(payload_str)
        except json.JSONDecodeError:
            payload = {"raw": payload_str}
        return {
            "timestamp": ts,
            "event": f"parser.{event_type}",
            "payload": payload,
        }
    
    # Legacy format: [TIMESTAMP] [TAG] description
    legacy_match = re.match(
        r'\[(.+?)\] \[(\w+)\] (.+)',
        line
    )
    if legacy_match:
        ts, tag, description = legacy_match.groups()
        return {
            "timestamp": ts,
            "event": "parser.legacy",
            "tag": tag,
            "description": description.strip(),
        }
    
    return None


def extract_dash_separator(observed: str) -> tuple[str, str] | None:
    """
    Detect dash-separator pattern: [TAG] – "prose" or [TAG] – prose
    Returns (tag_name, prose) or None.
    """
    m = re.match(
        r'\[([A-Z_]+)\](?:\s+[–-]\s*|\s+)'
        r'"?([^"]{5,})"?$',
        observed.strip()
    )
    if m:
        return m.group(1), m.group(2).strip()
    return None


def extract_id_in_save(observed: str) -> tuple[str, str] | None:
    """
    Detect [MEM_SAVE #ID | type] pattern.
    Returns (tag_name, id_str) or None.
    """
    m = re.match(r'\[MEM_SAVE\s+#(\d+)(?:\s*\|\s*\w+)?\]', observed.strip())
    if m:
        return "MEM_SAVE", m.group(1)
    return None


def extract_empty_tag(observed: str) -> str | None:
    """
    Detect [TAG] with no payload.
    Returns tag_name or None.
    """
    m = re.match(r'^\[([A-Z_]+)\]$', observed.strip())
    if m and m.group(1) != "REFLECT":
        return m.group(1)
    return None


def extract_schedule_malformed(observed: str) -> str | None:
    """
    Detect [SCHEDULE] prose with a number.
    Returns the number string or None.
    """
    m = re.search(r'\[SCHEDULE\][^0-9]*(\d+)', observed)
    if m:
        return m.group(1)
    return None


# ─── DPO record builder ─────────────────────────────────────────────────────────

def build_dpo_record(event: dict, record_id: int) -> dict | None:
    """Convert a parsed event into a DPO record. Returns None if not actionable."""
    
    payload = event.get("payload", {})
    observed = payload.get("observed", "")
    intent = payload.get("intent", "")
    reason = payload.get("reason", "")
    
    if not observed or not intent:
        return None
    
    rejected = observed
    chosen = None
    failure_class = None
    
    # ── Dash separator ──────────────────────────────────────────────────────
    ds = extract_dash_separator(observed)
    if ds:
        tag, prose = ds
        if tag in DASH_SEPARATOR_CORRECTIONS:
            chosen = DASH_SEPARATOR_CORRECTIONS[tag](prose)
            failure_class = "dash_separator"
    
    # ── ID in MEM_SAVE ──────────────────────────────────────────────────────
    if not chosen:
        id_save = extract_id_in_save(observed)
        if id_save:
            tag, id_str = id_save
            chosen = ID_IN_SAVE_CORRECTIONS[tag](id_str)
            failure_class = "id_in_save_should_be_focus"
    
    # ── Empty tag ───────────────────────────────────────────────────────────
    if not chosen and reason in ("empty_tag", "tag_not_parsed"):
        tag = extract_empty_tag(observed)
        if tag and tag in EMPTY_TAG_CORRECTIONS:
            chosen = EMPTY_TAG_CORRECTIONS[tag]
            failure_class = "empty_tag_no_payload"
    
    # ── Schedule malformed ──────────────────────────────────────────────────
    if not chosen and intent == "SCHEDULE" and reason == "malformed_tag":
        num = extract_schedule_malformed(observed)
        if num:
            chosen = f"[SCHEDULE {num}]"
        else:
            chosen = "[SCHEDULE 60]"
        failure_class = "schedule_malformed"
    
    # ── Generic malformed (MEM_FOCUS with wrong format) ─────────────────────
    if not chosen and intent == "MEM_FOCUS" and reason == "malformed_tag":
        # Check if there's a number we can extract
        ids = re.findall(r'#?(\d+)', observed)
        if ids:
            chosen = "[MEM_FOCUS #" + " #".join(ids) + "]"
            failure_class = "mem_focus_malformed"
    
    # ── REFLECT with params ─────────────────────────────────────────────────
    if not chosen and intent == "REFLECT" and reason == "malformed_tag":
        chosen = "[REFLECT]"
        failure_class = "reflect_with_params"
    
    if not chosen or not failure_class:
        return None  # Can't auto-correct — skip
    
    return {
        "id": f"mined_{record_id:05d}",
        "failure_class": failure_class,
        "intent": intent,
        "source": "parse_errors_log",
        "timestamp": event.get("timestamp", ""),
        "rejected_raw": rejected,
        "chosen": chosen,
        "rejected": rejected,
        "rejection_reason": reason,
        # Note: prompt field must be filled by the caller with a minimal context
        "prompt_note": "Fill prompt with a minimal realistic context for this tag intent."
    }


# ─── Statistics ─────────────────────────────────────────────────────────────────

def compute_statistics(events: list[dict], records: list[dict]) -> dict:
    """Compute failure frequency statistics for training prioritization."""
    
    event_type_counts = Counter(e.get("event") for e in events)
    
    malformed_events = [
        e for e in events
        if e.get("event") == "parser.malformed_intent"
    ]
    
    intent_counts = Counter(
        e.get("payload", {}).get("intent") for e in malformed_events
    )
    reason_counts = Counter(
        e.get("payload", {}).get("reason") for e in malformed_events
    )
    
    mined_class_counts = Counter(r.get("failure_class") for r in records)
    
    valid_events = [e for e in events if e.get("event") == "parser.valid_action"]
    valid_intent_counts = Counter(
        e.get("payload", {}).get("intent") for e in valid_events
    )
    
    total_malformed = len(malformed_events)
    total_valid = len(valid_events)
    parse_error_rate = total_malformed / max(1, total_malformed + total_valid)
    
    return {
        "summary": {
            "total_log_lines": len(events),
            "total_malformed_events": total_malformed,
            "total_valid_events": total_valid,
            "parse_error_rate": round(parse_error_rate, 4),
            "mined_dpo_records": len(records),
        },
        "event_type_distribution": dict(event_type_counts.most_common(20)),
        "malformed_by_intent": dict(intent_counts.most_common()),
        "malformed_by_reason": dict(reason_counts.most_common()),
        "mined_by_failure_class": dict(mined_class_counts.most_common()),
        "valid_by_intent": dict(valid_intent_counts.most_common()),
        "training_priority": _compute_training_priority(intent_counts, reason_counts),
    }


def _compute_training_priority(intent_counts: Counter, reason_counts: Counter) -> list[dict]:
    """
    Rank which failure modes need the most additional training data.
    Higher count = higher priority for more DPO pairs.
    """
    items = []
    for intent, count in intent_counts.most_common():
        items.append({
            "intent": intent,
            "failure_count": count,
            "recommended_additional_dpo_pairs": min(500, count * 3),
            "priority": "HIGH" if count > 50 else "MEDIUM" if count > 10 else "LOW",
        })
    return items


# ─── Main ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Mine parse_errors.log into DPO training records."
    )
    parser.add_argument("--log", default="logs/parse_errors.log",
                        help="Path to parse_errors.log")
    parser.add_argument("--out", default="finetune/dpo_mined.jsonl",
                        help="Output JSONL file for mined DPO records")
    parser.add_argument("--stats", default="finetune/failure_stats.json",
                        help="Output JSON file for failure statistics")
    parser.add_argument("--min-count", type=int, default=1,
                        help="Minimum occurrences of a pattern to include")
    args = parser.parse_args()
    
    log_path = Path(args.log)
    if not log_path.exists():
        print(f"ERROR: {log_path} not found", file=sys.stderr)
        sys.exit(1)
    
    print(f"Reading {log_path}...")
    raw_lines = log_path.read_text(encoding="utf-8").splitlines()
    
    # Parse all events
    events = []
    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        event = classify_event(line)
        if event:
            events.append(event)
    
    print(f"Parsed {len(events)} events from {len(raw_lines)} lines")
    
    # Mine DPO records from malformed_intent events
    malformed_events = [
        e for e in events
        if e.get("event") == "parser.malformed_intent"
    ]
    
    print(f"Processing {len(malformed_events)} malformed_intent events...")
    
    records = []
    record_id = 1
    skipped = 0
    
    for event in malformed_events:
        record = build_dpo_record(event, record_id)
        if record:
            records.append(record)
            record_id += 1
        else:
            skipped += 1
    
    # Deduplicate by (rejected_raw, chosen) — same pattern, same correction
    seen = set()
    unique_records = []
    for r in records:
        key = (r["rejected_raw"], r["chosen"])
        if key not in seen:
            seen.add(key)
            unique_records.append(r)
    
    print(f"Mined {len(records)} records -> {len(unique_records)} unique after deduplication")
    print(f"Skipped {skipped} events (could not auto-correct)")
    
    # Write DPO records
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for record in unique_records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"Written {len(unique_records)} DPO records to {out_path}")
    
    # Compute and write statistics
    stats = compute_statistics(events, unique_records)
    stats_path = Path(args.stats)
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    print(f"Written failure statistics to {stats_path}")
    
    # Print summary
    print("\n" + "="*60)
    print("FAILURE ANALYSIS SUMMARY")
    print("="*60)
    s = stats["summary"]
    print(f"  Parse error rate:     {s['parse_error_rate']*100:.1f}%")
    print(f"  Total valid actions:  {s['total_valid_events']}")
    print(f"  Total failures:       {s['total_malformed_events']}")
    print(f"  Mined DPO records:    {s['mined_dpo_records']}")
    print()
    print("TOP FAILURE INTENTS (need most DPO pairs):")
    for item in stats["training_priority"][:8]:
        bar = "#" * min(20, item["failure_count"] // 5)
        print(f"  [{item['priority']:6}] {item['intent']:25} {bar} {item['failure_count']}")
    print()
    print("FAILURE REASONS:")
    for reason, count in stats["malformed_by_reason"].items():
        print(f"  {reason:35} {count}")
    print("="*60)
    print(f"\nNext step: Review {out_path}")
    print("Add a realistic 'prompt' field to each record, then merge with dpo_train.jsonl")


if __name__ == "__main__":
    main()
