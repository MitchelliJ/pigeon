-- 0005: per-user custom triage instructions for the LLM
-- ("people should be able to categorise important vs unimportant per their
--   own llm instructions" — RAMBLINGS.txt).

ALTER TABLE users ADD COLUMN llm_instructions text NOT NULL DEFAULT '';
