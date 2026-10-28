-- CreateTable
CREATE TABLE "IpLocation" (
    "ip" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "lookedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IpLocation_pkey" PRIMARY KEY ("ip")
);

