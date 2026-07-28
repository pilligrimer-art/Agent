#!/usr/bin/env python3
"""
validate_dataset.py — Validate training data before submitting to training.

Checks:
1. SFT records: messages structure, assistant completion is valid
2. DPO records: chosen/rejected present, chosen parses correctly, rejected fails
3. Detects forbidden output patterns in chosen responses
4. Reports pass/fail per record with specific error messages

Usage:
    python finetune/validate_dataset.py --sft finetune/sft_train.jsonl
    python finetune/validate_dataset.py --dpo finetune/dpo_train.jsonl
    python finetune/validate_dataset.py --sft finetune/sft_train.jsonl --dpo finetune/dpo_train.jsonl
"""

import json
import re
import sys
import argparse
from pathlib import Path
from collections import Counter


# ─── Tag Protocol Validator ──────────────────────────────────────────────────────

REGISTERED_TAGS = {
    "MEM_SAVE", "MEM_DELETE", "MEM_FOCUS", "MEM_ADAPT",
    "MEM_ADAPT_CHALLENGE", "MEM_ADAPT_WEAKEN",
    "SCHEDULE", "REFLECT", "SEND_MESSAGE", "HELP_ACTION", "HELP_ACTIONS"
}

# Tags that require JSON payloads
TAGS_REQUIRE_JSON = {"MEM_SAVE", "MEM_ADAPT", "MEM_ADAPT_CHALLENGE", "MEM_ADAPT_WEAKEN", "SEND_MESSAGE"}
TAGS_REQUIRE_JSON_OPTIONAL = {"MEM_FOCUS"}  # block form requires JSON; inline form doesn't

# MEM_SAVE required fields
MEM_SAVE_SHORT_REQUIRED = {"type", "content", "priority", "why"}
MEM_SAVE_LONG_REQUIRED = {"type", "content", "tags", "why"}

# FORBIDDEN patterns in chosen responses
FORBIDDEN_PATTERNS = [
    (r'\[[A-Z_]+\]\s+[–—-]\s+', "dash_separator"),
    (r'\[[A-Z_]+\]\s+[–—-]\s*"', "dash_separator_quoted"),
    (r'\[SCHEDULE\]\s*Schedule', "schedule_prose"),
    (r'\[SCHEDULE\]\s*$', "schedule_empty"),
    (r'\[MEM_SAVE\]\s*$', "mem_save_empty"),
    (r'\[MEM_SAVE\s+#\d+', "id_in_save"),
    (r'\[MEM_FOCUS\]\s*$', "mem_focus_empty"),
    (r'\[REFLECT\]\s+\w', "reflect_with_param"),
    (r'\[(WEB_SEARCH|EXECUTE|SLEEP|WAIT|DELAY|STORE|REMEMBER|FETCH|MEM_PROMOTE|MEM_PIN)\]', "hallucinated_tag"),
]


def extract_tags(text: str) -> list[dict]:
    """
    Extract all agent tags from text.
    Tags have the form:
      [TAG_NAME]              — no payload (REFLECT, HELP_ACTIONS)
      [TAG_NAME N]            — bare value (SCHEDULE 60)
      [TAG_NAME store]        — store qualifier (MEM_SAVE short, MEM_DELETE short #ID)
      [TAG_NAME #ID1 #ID2]    — ID list (MEM_FOCUS #L11 #L14)
    JSON payloads follow on the SAME LINE after the closing bracket:
      [MEM_SAVE short] {"type":"task",...}
    """
    results = []
    # Match [TAG_NAME optional_body] — body is everything inside brackets except nested brackets
    # The JSON payload, if any, comes AFTER the closing bracket on the same line
    pattern = re.compile(
        r'\[([A-Z_]+)([^\[\]]*)\]'   # [TAG body]
        r'([ \t]*\{[^\n]*)?',        # optional JSON payload on same line
        re.DOTALL
    )
    for m in pattern.finditer(text):
        tag_name = m.group(1).strip()
        tag_bracket_body = m.group(2).strip()   # e.g. "short", "#L11 #L14", "60"
        tag_json_payload = (m.group(3) or "").strip()  # e.g. '{"type":"task",...}'
        results.append({
            "name": tag_name,
            "bracket_body": tag_bracket_body,
            "json_payload": tag_json_payload,
            "full": m.group(0),
            "end_pos": m.end(),
            "pos": m.start(),
        })
    return results


def validate_completion(text: str, record_id: str) -> list[str]:
    """
    Validate a completion (assistant turn) against the protocol.
    Returns a list of error messages (empty = valid).
    """
    errors = []
    
    # 1. Check for forbidden patterns
    for pattern, label in FORBIDDEN_PATTERNS:
        if re.search(pattern, text):
            errors.append(f"FORBIDDEN_PATTERN:{label}")
    
    # 2. Extract all tags
    tags = extract_tags(text)
    
    # Filter to only registered-looking tags (ignore [S12], [L5], etc. from memory cards in prompts)
    agent_tags = [t for t in tags if t["name"] in REGISTERED_TAGS or len(t["name"]) > 3]
    agent_tags = [t for t in agent_tags if t["name"] in REGISTERED_TAGS]
    
    # 3. Check tag vocabulary — any [ALL_CAPS] pattern that isn't registered
    all_caps_tags = re.findall(r'\[([A-Z][A-Z_]{2,})\s*[\]\s]', text)
    for tn in all_caps_tags:
        if tn not in REGISTERED_TAGS:
            errors.append(f"UNKNOWN_TAG:[{tn}]")
    
    # 4. Validate payloads for tags that require them
    for tag in agent_tags:
        name = tag["name"]
        bracket_body = tag["bracket_body"]  # what's INSIDE the brackets after tag name
        json_payload = tag["json_payload"]  # what follows the closing bracket
        
        if name in TAGS_REQUIRE_JSON:
            # The JSON payload follows the closing bracket: [MEM_SAVE short] {"type":...}
            if not json_payload or not json_payload.startswith("{"):
                errors.append(f"MISSING_JSON_PAYLOAD:{name}")
                continue
            try:
                payload = json.loads(json_payload)
            except json.JSONDecodeError as e:
                errors.append(f"INVALID_JSON:{name}:{str(e)[:60]}")
                continue
            
            # Check required fields
            if name == "MEM_SAVE":
                if "short" in bracket_body:
                    required = MEM_SAVE_SHORT_REQUIRED
                elif "long" in bracket_body:
                    required = MEM_SAVE_LONG_REQUIRED
                else:
                    errors.append("MEM_SAVE_MISSING_STORE_TYPE")
                    continue
                missing = required - set(payload.keys())
                if missing:
                    errors.append(f"MISSING_FIELDS:{name}:{','.join(sorted(missing))}")
            
            elif name == "SEND_MESSAGE":
                if "text" not in payload:
                    errors.append("MISSING_FIELDS:SEND_MESSAGE:text")
            
            elif name == "MEM_ADAPT":
                for field in ("type", "target", "rule", "why"):
                    if field not in payload:
                        errors.append(f"MISSING_FIELDS:MEM_ADAPT:{field}")
            
            elif name in ("MEM_ADAPT_CHALLENGE", "MEM_ADAPT_WEAKEN"):
                if "id" not in payload:
                    errors.append(f"MISSING_FIELDS:{name}:id")
        
        elif name == "SCHEDULE":
            # Must have a bare integer in bracket_body
            if not re.match(r'^\d+$', bracket_body):
                errors.append(f"SCHEDULE_INVALID_VALUE:{bracket_body!r}")
        
        elif name == "MEM_DELETE":
            # Must have store type and ID in bracket_body: 'short #S70'
            if not re.match(r'^(short|long)\s+#\w+', bracket_body):
                errors.append(f"MEM_DELETE_INVALID_FORMAT:{bracket_body!r}")
    
    # 5. Check tag ordering — SCHEDULE must be last
    tag_names = [t["name"] for t in agent_tags]
    if "SCHEDULE" in tag_names and tag_names[-1] != "SCHEDULE":
        errors.append("SCHEDULE_NOT_LAST")
    
    # 6. Check for prose text between tags (after first tag begins)
    # Find the position of the first agent tag in the text
    if agent_tags:
        first_tag_pos = agent_tags[0]["pos"]
        after_tags = text[first_tag_pos:]
        # Look for substantial non-tag text between tags
        # Strip all [TAG] {...} blocks and see what's left between them
        stripped = re.sub(r'\[[A-Z_]+[^\[\]]*\](?:\s*\{[^{}]*\})?', '', after_tags)
        between_lines = [l.strip() for l in stripped.splitlines() if l.strip()]
        prose_between = [l for l in between_lines if len(l) > 10]
        if prose_between:
            errors.append(f"TEXT_BETWEEN_TAGS:{prose_between[0][:50]!r}")
    
    return errors


# ─── SFT Validator ────────────────────────────────────────────────────────────────

def validate_sft_record(record: dict) -> list[str]:
    errors = []
    
    # Structure
    if "id" not in record:
        errors.append("MISSING_FIELD:id")
    if "messages" not in record:
        errors.append("MISSING_FIELD:messages")
        return errors
    
    messages = record["messages"]
    if not messages:
        errors.append("EMPTY_MESSAGES")
        return errors
    
    roles = [m.get("role") for m in messages]
    if roles[0] != "system":
        errors.append("FIRST_MESSAGE_NOT_SYSTEM")
    if roles[-1] != "assistant":
        errors.append("LAST_MESSAGE_NOT_ASSISTANT")
    
    # Validate the assistant completion
    assistant_turns = [m for m in messages if m.get("role") == "assistant"]
    if not assistant_turns:
        errors.append("NO_ASSISTANT_TURN")
    else:
        completion = assistant_turns[-1].get("content", "")
        if not completion.strip():
            errors.append("EMPTY_COMPLETION")
        else:
            completion_errors = validate_completion(completion, record.get("id", "?"))
            errors.extend(completion_errors)
    
    return errors


# ─── DPO Validator ────────────────────────────────────────────────────────────────

def validate_dpo_record(record: dict) -> list[str]:
    errors = []
    
    if "id" not in record:
        errors.append("MISSING_FIELD:id")
    if "chosen" not in record:
        errors.append("MISSING_FIELD:chosen")
    if "rejected" not in record:
        errors.append("MISSING_FIELD:rejected")
    if "failure_class" not in record:
        errors.append("MISSING_FIELD:failure_class")
    
    if errors:
        return errors
    
    chosen = record["chosen"]
    rejected = record["rejected"]
    
    # Chosen must be valid
    chosen_errors = validate_completion(chosen, record.get("id", "?"))
    for e in chosen_errors:
        errors.append(f"CHOSEN_INVALID:{e}")
    
    # Rejected must NOT be identical to chosen
    if chosen.strip() == rejected.strip():
        errors.append("CHOSEN_EQUALS_REJECTED")
    
    # Rejected should contain a known failure pattern (sanity check)
    has_known_failure = any(
        re.search(p, rejected)
        for p, _ in FORBIDDEN_PATTERNS
    )
    
    # Check failure_class is a known type
    known_classes = {
        "dash_separator", "empty_tag", "missing_json_field", "id_mistake",
        "schedule_malformed", "schedule_empty", "schedule_invalid_value",
        "mem_focus_malformed", "mem_focus_no_id", "hallucinated_tag",
        "reasoning_interleaved", "truncated_json", "invalid_json",
        "reflect_with_params", "chat_behavior", "id_in_save_should_be_focus",
        "dash_separator_no_json", "dash_separator_prose", "dash_separator_quoted",
        "reflect_with_param", "missing_required_field_type", "missing_required_field_why",
        "id_not_valid_for_save", "hallucinated_tag_web_search",
        "hallucinated_tag_execute", "hallucinated_synonym_sleep",
        "hallucinated_synonym_store", "hallucinated_tag_mem_promote",
        "chat_assistant_behavior", "chat_behavior_assumption",
    }
    if record.get("failure_class") not in known_classes:
        errors.append(f"UNKNOWN_FAILURE_CLASS:{record.get('failure_class')}")
    
    return errors


# ─── Main ────────────────────────────────────────────────────────────────────────

def validate_file(path: str, validator_fn, label: str) -> bool:
    p = Path(path)
    if not p.exists():
        print(f"ERROR: {path} not found")
        return False
    
    records = []
    with open(p, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append((i, json.loads(line)))
            except json.JSONDecodeError as e:
                print(f"  [LINE {i}] JSON PARSE ERROR: {e}")
    
    print(f"\n{'='*60}")
    print(f"Validating {label}: {path}")
    print(f"{'='*60}")
    print(f"Records: {len(records)}")
    
    passed = 0
    failed = 0
    all_errors = Counter()
    
    for line_num, record in records:
        errors = validator_fn(record)
        if errors:
            failed += 1
            for e in errors:
                all_errors[e] += 1
            if failed <= 10:  # Show first 10 failures in detail
                print(f"  [FAIL] {record.get('id', f'line:{line_num}')}: {'; '.join(errors)}")
        else:
            passed += 1
    
    print(f"\nResults: {passed} PASSED, {failed} FAILED")
    
    if all_errors:
        print(f"\nError frequency:")
        for error, count in all_errors.most_common(15):
            print(f"  {error:55} {count:4}x")
    
    pass_rate = passed / max(1, len(records))
    print(f"\nPass rate: {pass_rate*100:.1f}%", end="")
    
    if pass_rate >= 0.98:
        print(" [OK] READY FOR TRAINING")
        return True
    elif pass_rate >= 0.90:
        print(" [WARN] REVIEW FAILURES BEFORE TRAINING")
        return False
    else:
        print(" [FAIL] NOT READY -- TOO MANY FAILURES")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Validate fine-tuning datasets before training"
    )
    parser.add_argument("--sft", help="SFT JSONL file to validate")
    parser.add_argument("--dpo", help="DPO JSONL file to validate")
    args = parser.parse_args()
    
    if not args.sft and not args.dpo:
        parser.print_help()
        sys.exit(1)
    
    all_passed = True
    
    if args.sft:
        ok = validate_file(args.sft, validate_sft_record, "SFT Dataset")
        all_passed = all_passed and ok
    
    if args.dpo:
        ok = validate_file(args.dpo, validate_dpo_record, "DPO Dataset")
        all_passed = all_passed and ok
    
    print(f"\n{'='*60}")
    if all_passed:
        print("ALL DATASETS VALID — proceed to training")
        sys.exit(0)
    else:
        print("VALIDATION FAILED — fix errors before training")
        sys.exit(1)


if __name__ == "__main__":
    main()
