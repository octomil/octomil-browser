import type { PredictInput, PredictOutput } from "../types.js";

export interface TextPredictionRequest {
  input: string;
}

export interface TextPredictionResult {
  output: PredictOutput;
}

export class TextPredictionsClient {
  constructor(
    private readonly runPrediction: (input: PredictInput) => Promise<PredictOutput>,
  ) {}

  async create(request: TextPredictionRequest): Promise<TextPredictionResult> {
    const output = await this.runPrediction({ text: request.input });
    return { output };
  }
}

export class OctomilText {
  readonly predictions: TextPredictionsClient;

  constructor(
    runPrediction: (input: PredictInput) => Promise<PredictOutput>,
  ) {
    this.predictions = new TextPredictionsClient(runPrediction);
  }

  async predict(input: string): Promise<PredictOutput> {
    return this.predictions.create({ input }).then((result) => result.output);
  }
}
