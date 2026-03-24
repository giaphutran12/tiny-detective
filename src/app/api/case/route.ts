import { NextRequest } from "next/server";
import {
  buildSellerCentricCaseDossier,
  caseRequestSchema,
  mockInvestigationForUrl,
} from "@/lib/investigation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = caseRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ error: "Invalid case payload" }, { status: 400 });
  }

  const investigation = {
    ...mockInvestigationForUrl(parsed.data.investigation.officialUrl),
    ...parsed.data.investigation,
  };

  const dossier = buildSellerCentricCaseDossier(
    parsed.data.selectedCandidateIds,
    investigation,
  );

  return Response.json(dossier);
}

