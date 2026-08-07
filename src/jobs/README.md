# src/jobs

Background job queues, producers and workers.

Reserved for the BullMQ + Redis phase. Long-running work — mailbox
synchronisation, bulk sends, Microsoft Graph delta polling — belongs here rather
than in a request handler, so an HTTP request never waits on it.

Neither `bullmq` nor `ioredis` is installed yet; they are added in the phase
that introduces them.
