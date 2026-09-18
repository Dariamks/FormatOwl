ALTER TABLE transcription_chunks ADD COLUMN provider_config jsonb;
ALTER TABLE transcription_chunks ADD COLUMN provider_task_id text;
