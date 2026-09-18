-- Browser database roles have no direct access. The server owns these tables
-- and enforces job ownership through the existing API, as with assets/jobs.
ALTER TABLE translation_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_capabilities ENABLE ROW LEVEL SECURITY;
-- Video translation reuses the persisted speech data and export services.
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcription_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_exports ENABLE ROW LEVEL SECURITY;
