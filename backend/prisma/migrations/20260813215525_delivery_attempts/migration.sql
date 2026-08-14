-- CreateEnum
CREATE TYPE "AttemptErrorClass" AS ENUM ('TIMEOUT', 'CONN_REFUSED', 'HTTP_4XX', 'HTTP_5XX', 'SSRF_BLOCKED');

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" BIGSERIAL NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "request_headers_digest" CHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body_head" VARCHAR(1024),
    "error_class" "AttemptErrorClass",
    "duration_ms" INTEGER,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_delivery_id_attempt_no_key" ON "delivery_attempts"("delivery_id", "attempt_no");

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
