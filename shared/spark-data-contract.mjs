export const sparkAnalysisContractVersion = "2026.05.backend-analysis.1";

export const sparkReplayAnalysisSchema = {
  version: sparkAnalysisContractVersion,
  topLevel: [
    "parser",
    "players",
    "teams",
    "analysis",
    "nameAliases",
    "durationSeconds",
    "hasOvertime"
  ],
  playerArrays: [
    "boostPickups",
    "shotSamples",
    "touchEvents",
    "demoEvents",
    "bumpEvents",
    "distanceToBallSamples",
    "positionSamples"
  ]
};
