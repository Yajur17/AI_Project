import dotenv from "dotenv";
dotenv.config();

const prompts = [
  "What is machine learning?",
  "Explain machine learning like I'm 5",
  "Machine learning definition for engineer",
  "ML in bullet points",
  "Compare ML to traditional programming",
];

import OpenAI from "openai";
import fs from "fs";

const temperatures = [0, 0.5, 1.0, 1.5, 2.0];
//const prompt = "Give a creative product name for a coffee shop";
const SOURCE_FILE = "prompt.js";

function logToFile(label, data, sourceFile = SOURCE_FILE) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${sourceFile}] ${label}:\n${JSON.stringify(data, null, 2)}\n\n`;
  fs.appendFileSync("api_calls.log", entry);
}

const client = new OpenAI({
  apiKey: process.env.key,
});

const tmp=0;

//console.log(__dirname,__filename);

for (const prompt of prompts) {
    console.log(prompt);
    const requestPayload = {
  model: "gpt-4o",
  input: [{ role: "user", content: prompt }],
};
logToFile("REQUEST", requestPayload);

  const response = await client.responses.create(requestPayload);

logToFile("RESPONSE", response);
console.log({
output_text: response.output_text,
temperature: response.temperature,
inputToken: response.usage.input_tokens,
outputToken: response.usage.output_tokens,
totalTokens: response.usage.total_tokens,
Estimated_Cost: ( response.usage.input_tokens * 0.00003 + response.usage.output_tokens * 0.00006) / 1000,
});
}

