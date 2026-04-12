# API Calls Analysis

This note summarizes what your API call data shows from:

- `api_calls_summary.csv`
- `api_calls.log`

The goal is to make the patterns easy to understand while you learn how prompts, temperature, tokens, cost, and response size relate to each other.

## Quick Summary

The main pattern is simple:

**Your cost is mostly driven by how long the model answers, not by how long your prompt is.**

In your data:

- Average input tokens per call: **14.07**
- Average output tokens per call: **186.86**
- Average total tokens per call: **200.93**
- Average cost per call: **$0.00001163**

So the output side is much larger than the input side.

## What You Logged

You currently have **14 API calls** in the CSV.

These include:

- very short creative naming prompts
- medium-length explanation prompts
- long comparison and bullet-point style prompts

Some older rows show `unknown` in `source_file` because those calls were made before filename logging was added.

## Biggest Learning: Output Tokens Control Cost

Your pricing formula in the data is:

- input cost = `input_tokens * 0.00003 / 1000`
- output cost = `output_tokens * 0.00006 / 1000`

That means output tokens matter more for two reasons:

1. You usually generate far more output tokens than input tokens.
2. Your output token rate is higher than your input token rate.

### What this means in practice

If the model gives:

- a one-line answer, cost stays very low
- a detailed explanation, list, or comparison, cost rises quickly

## Clear Examples From Your Data

### Cheapest calls

These were your short naming-style prompts:

| Prompt | Temperature | Input Tokens | Output Tokens | Cost |
| --- | --- | ---: | ---: | ---: |
| Write a creative product name for a coffee shop | 0 | 16 | 4 | $0.00000072 |
| Give a creative product name for a coffee shop | 0 | 16 | 7 | $0.00000090 |
| Give a creative product name for my coffee shop | 0 | 16 | 10 | $0.00000108 |

These stayed cheap because the model answered with only a few words.

From the log, the outputs were things like:

- `Brew Haven`
- `"Bean & Brew Haven"`
- `Sure! How about "Brew Haven"?`

### Most expensive calls

These were your long explanation/comparison prompts:

| Prompt | Temperature | Input Tokens | Output Tokens | Cost |
| --- | --- | ---: | ---: | ---: |
| Explain quantum computing | 1 | 10 | 517 | $0.00003132 |
| Compare ML to traditional programming | 1 | 12 | 500 | $0.00003036 |
| ML in bullet points | 1 | 11 | 360 | $0.00002193 |

These cost more because the model produced long, structured answers.

## What Changes When the Prompt Changes

This is the strongest pattern in your data.

### Short, constrained prompts

Example:

- `Write a creative product name for a coffee shop`

What happened:

- input tokens stayed low
- output tokens stayed extremely low
- cost stayed extremely low
- answers were short and direct

### Broad explanation prompts

Examples:

- `Explain quantum computing`
- `What is machine learning?`
- `Compare ML to traditional programming`

What happened:

- input tokens were still low
- output tokens increased a lot
- cost increased mainly because the answers got longer
- responses became paragraph-heavy or multi-section explanations

### Same topic, different phrasing

The machine learning prompts are a good lesson:

| Prompt | Output Tokens | Cost |
| --- | ---: | ---: |
| What is machine learning? | 219 | $0.00001350 |
| Explain machine learning like I'm 5 | 68 | $0.00000450 |
| Machine learning definition for engineer | 85 | $0.00000546 |
| ML in bullet points | 360 | $0.00002193 |
| Compare ML to traditional programming | 500 | $0.00003036 |

This shows that **prompt framing changes answer length a lot**.

For example:

- `like I'm 5` encouraged a simpler, shorter answer
- `definition for engineer` gave a more technical but still controlled answer
- `bullet points` encouraged a structured longer response
- `compare` encouraged the longest and most detailed response

## What the Log Shows About Response Style

The CSV gives token and cost numbers.
The log helps explain *why* those numbers changed.

### Coffee health prompt

Prompt:

- `How Should I Drink my coffee to be healthy?`

What the log shows:

- the model answered with a numbered advice list
- one response was about **157 words**
- another was about **198 words**

Result:

- output tokens were **213** and **274**
- cost was noticeably higher than the short naming prompts

### Quantum computing prompt

Prompt:

- `Explain quantum computing`

What the log shows:

- the model wrote long educational explanations
- one response was about **255 words**
- another was about **382 words**

Result:

- output tokens were **324** and **517**
- these became some of the most expensive calls in your data

### Creative naming prompt

Prompt:

- `Write a creative product name for a coffee shop`

What the log shows:

- the model answered with only a name
- output was about **2 words**

Result:

- output tokens were only **4**
- cost was almost zero at this scale

## What About Temperature?

Your data does **not** isolate temperature well enough yet to make a strong conclusion.

Why not:

- most of the calls are at temperature **1**
- the calls at temperature **0** are mostly naming prompts
- that means prompt type and temperature changed together

So if you ask:

**Did temperature change the cost?**

The safe answer is:

**Not enough evidence from this dataset alone.**

### What you can say safely

- Temperature `0` calls were cheap in your data.
- But those were also short-output naming prompts.
- Temperature `1` calls were more expensive in your data.
- But those were also broader prompts that naturally invite longer responses.

So right now, **prompt type is the clearer cause than temperature**.

## Interesting Finding: Same Prompt, Different Output Size

Even when the prompt and temperature stayed the same, output length still changed.

Examples:

### Coffee prompt at temperature 1

- output tokens: **213**
- output tokens: **274**

### Quantum computing prompt at temperature 1

- output tokens: **324**
- output tokens: **517**

This teaches an important lesson:

**The model is not perfectly deterministic in your current setup.**

So even with the same prompt:

- response wording can change
- response length can change
- cost can change

## File-Level View

From the CSV:

| Source File | Calls | Input Tokens | Output Tokens | Total Estimated Cost |
| --- | ---: | ---: | ---: | ---: |
| unknown | 9 | 136 | 1384 | $0.00008712 |
| prompt.js | 5 | 61 | 1232 | $0.00007575 |

Important note:

- `unknown` does **not** mean the call source was truly unknown in your code.
- it only means those calls were logged before you added file name tracking

## Best Practical Rules To Remember

If you want to control cost, these are the most useful rules from your data:

### 1. Ask for shorter output when you can

Examples:

- `answer in one sentence`
- `keep it under 50 words`
- `give only 3 bullet points`
- `respond with only the final name`

This will usually reduce output tokens and therefore reduce cost.

### 2. Broad prompts usually cost more

Prompts like:

- `Explain...`
- `Compare...`
- `Give bullet points...`

often create longer answers.

### 3. Prompt wording matters more than prompt length

A short prompt can still be expensive if it asks for a long explanation.

Example:

- `Explain quantum computing`

This is a short prompt, but it produced one of your biggest outputs.

### 4. Same prompt can still vary in cost

Even when nothing obvious changes, output length may differ.

So for learning and testing:

- run the same prompt multiple times
- compare the spread in output tokens
- look at average behavior, not just one run

## Final Takeaway

If you want one sentence to remember, it is this:

**In your current experiments, prompt style controls response length, and response length controls cost.**

That is the clearest pattern in your data.

## Good Next Experiments

If you want to learn this properly, the cleanest next experiments are:

### Experiment 1: Prompt vs cost

Keep temperature fixed.
Try the same topic with different prompt styles:

- one sentence
- 3 bullet points
- detailed explanation
- compare two ideas

Then check how output tokens and cost change.

### Experiment 2: Temperature vs variation

Keep the prompt fixed.
Try:

- `0`
- `0.5`
- `1`
- `1.5`

Then compare:

- output length
- style changes
- repeatability

### Experiment 3: Add output-length instructions

For the same prompt, test:

- `answer in 20 words`
- `answer in 100 words`
- `answer in bullet points`

This will help you see how directly you can control token usage.