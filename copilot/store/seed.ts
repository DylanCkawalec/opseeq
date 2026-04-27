// store/seed.ts — Seeds default role→model bindings into Postgres.
import { PrismaClient } from "@prisma/client";
import { registry } from "../models/registry.ts";

const prisma = new PrismaClient();

async function main() {
  for (const b of registry().list()) {
    await prisma.modelBinding.upsert({
      where: { role: b.role },
      create: { role: b.role, provider: b.provider, model: b.model },
      update: { provider: b.provider, model: b.model },
    });
    await prisma.modelBindingAudit.create({
      data: { role: b.role, provider: b.provider, model: b.model, changedBy: "seed" },
    });
  }
  console.log("[seed] role bindings persisted");
}

main().finally(() => prisma.$disconnect());
