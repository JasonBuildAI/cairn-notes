---
title: "Model selection, fine-tuning, and deployment"
description: "From capabilities, data, and evaluation, to fine-tuning, quantization, inference services, version governance, and cost control."
---

The model lifecycle is not "pick the strongest model and launch it." It starts from task definition, goes through data processing, model or API selection, evaluation, optimization, deployment, monitoring, and version rollback. Each stage can amplify errors from the previous stage.

## 1. First, clarify the task

Before choosing a model, define:

- What is the input: text, images, audio, structured data, or multi-turn operations.
- What is the output: free text, classification, JSON, tool calls, or files.
- What are the success criteria: accuracy, citation support, latency, cost, availability.
- Which errors are acceptable and which are absolutely not allowed.
- Whether data can leave the deployment environment, and whether auditing and deletion are required.
- Who the users are, and what are the permission and risk boundaries.

"Answering better" is not a verifiable goal. Specific evaluation examples are needed, for instance: "Among 300 internal support questions, achieve 85% accuracy, citations support the conclusion, p95 first token under 800 ms."

## 2. Capability, latency, and cost

Model selection is a multi-objective trade-off:

| Dimension | What to consider |
| --- | --- |
| Quality | Domain correctness, instruction following, format, reasoning depth |
| Context | Maximum tokens, effective length utilization, long document recall |
| Output | Multimodal, structured, tool calls, coding capabilities |
| Latency | First token, complete response, batch throughput |
| Cost | Input/output tokens, number of calls, GPU/memory usage |
| Deployment | API or self-hosted, region, privacy, availability |
| Risk | Data usage, content safety, version stability |

The largest model is not necessarily the most suitable. Small models may be more cost-effective for well-defined tasks, short outputs, and high-concurrency scenarios; large models are suitable for complex reasoning, long context, and low-tolerance tasks. A routing strategy can be used: simple requests go to small models, complex requests are escalated.

### 2.1 Latency breakdown

```text
Total latency = queuing +  retrieval/preprocessing +  model first token +  generation +  post-processing
```

First token latency and total response latency are different metrics. Chat interfaces need a fast first token, while batch summarization is more concerned with total throughput. The longer the context, the more output, and the higher the concurrency, the greater the cost and time usually are.

### 2.2 Cost Breakdown

- Number of input tokens and output tokens.
- Retrieval, reranking, and tool invocation costs.
- Retry, failure, and invalid calls.
- Self-managed GPU utilization, idle capacity, and operational manpower.
- Data storage, logging, and evaluation costs.

Don't just look at the price per API call. High failure rates and long contexts can make a 'cheap model' more expensive overall.

## 3. Evaluation

The evaluation set should come from real tasks, not just pick a few nice examples.

### 3.1 Data Partitioning

- Training/Development Set: Tuning prompts, fine-tuning, and small-scale experiments.
- Validation set: model and parameter selection.
- Test set: final evaluation, to avoid contamination from repeated parameter tuning.
- Regression set: historical incidents and fixed issues.
- Adversarial set: injection, privilege escalation, boundary input, and malicious content.

The samples should cover normal, boundary, no-answer, conflict, long input, and multilingual scenarios. Annotation guidelines must be standardized; otherwise, the 'correct' answers from different annotators will not be the same.

### 3.2 Indicators

| Task | Metric |
| --- | --- |
| Category | Accuracy, Precision, Recall, F1, Confusion Matrix |
| Extraction | Field-level precision/recall, structural validity |
| Generation | Human preferences, factuality, citation support, format compliance |
| Retrieval | Recall@k, MRR, NDCG, Permission Violation Rate |
| Agent | Task completion rate, steps, tool error rate, cost |
| System | First token, p95 latency, error rate, unit task cost |

Offline metrics must be connected with online results. It is possible to record whether users adopt, modify, follow up, or roll back, but click-through rate cannot be simply equated with quality.

### 3.3 LLM-as-a-judge

Using models for review can expand the scale of evaluation, but review models may also be biased:

- Prefers long answers, specific formats, or their own style.
- Insensitive to factual errors.
- Unable to understand professional boundaries.
- Scores are unstable.

Manual annotation calibration should be used, review prompts and versions should be fixed, sampling rechecks should be conducted, and original evidence should be retained.

## 4. Fine-tuning is not the default answer

Fine-tuning changes the model parameters, suitable for:

- Fixed output style or format.
- Study domain-specific terminology and patterns.
- Improve the performance of small models on a large number of stable samples.
- Reduce reliance on long prompts and ultra-large models.

It is not suitable for:

- Frequently changing knowledge.
- Data that requires citations and permission filtering.
- Tasks with very little data and unstable quality.
- Simple problems that can be solved by prompts alone.

### 4.1 Data Quality

Training samples should:

- Consistent with the real input distribution.
- There are unified and verifiable annotations.
- Remove duplicates and prevent test set leakage.
- Cover boundaries and refuse answers.
- Compliant with privacy, copyright, and authorization requirements.

A small amount of high-quality samples is usually more valuable than a large number of low-quality samples. Data cleaning, deduplication, and incorrect labels will directly affect fine-tuning results, so you can't just focus on training parameters.

### 4.2 SFT

Supervise fine-tuning by input-output samples to train the model to imitate target responses. It is suitable for teaching format, task workflow, and style, but cannot automatically ensure factual accuracy. A decrease in training loss does not indicate an improvement in task metrics, and evaluation must be done using an independent validation set.

### 4.3 Preference Optimization

When a 'good answer' is difficult to write as a single correct answer, preference pairs can be collected and optimized using methods like RLHF and DPO. Preference data is easily affected by annotators, length, and format biases, and it is also necessary to prevent the model from learning to please rather than being truthful.

### 4.4 LoRA and Quantization Fine-Tuning

LoRA freezes the base model and only trains the low-rank matrices, making it suitable for multi-task adaptation and lower VRAM usage. Quantized fine-tuning further reduces VRAM, but may affect stability and quality. It is necessary to record the versions of the base model, adapters, training data, and merging method.

## 5. Compression and Inference Optimization

### 5.1 Quantification

Reduce weights or activations from high precision to low precision to decrease memory and bandwidth usage and increase throughput. Common methods include 8-bit and 4-bit. Quantization may change the output distribution, especially for tasks involving mathematics, code, and long contexts.

The evaluation should compare:

- Task quality.
- Output stability.
- First token and throughput.
- Video memory and concurrency limits.
- Degradation under different input lengths.

### 5.2 Distillation

Use large models or teacher models to generate signals and train smaller student models. Students can reduce inference costs but will lose some capabilities. The quality of training data, teacher errors, and the scope of tasks determine the upper limit.

### 5.3 Compilation and Runtime

Graph optimization, operator fusion, KV cache, PagedAttention, continuous batching, and dedicated inference engines can improve throughput. Optimization must be based on profiling; do not change quantization, batching, and sampling parameters simultaneously, otherwise it will be impossible to determine the source of the gains.

### 5.4 Batch Processing

Online requests and offline tasks have different objectives:

- Online pursuit of low latency and fairness requires dynamic batching to balance throughput and queuing.
- For offline pursuit of total throughput, you can use larger batches, asynchronous tasks, and preemption.
- Mixing long and short requests can cause head-of-line blocking; you can split the queue or set a timeout.

## 6. Deployment Methods

| Method | Advantages | Cost |
| --- | --- | --- |
| Managed Model API | Fast, low maintenance, capability updates | Data boundaries, cost, quotas, vendor dependency |
| Self-hosted inference | Controllable, private, and customizable | GPU, operations, scaling, and security responsibilities |
| Hybrid routing | Simple requests locally, complex requests externally | Routing, consistency, and cost monitoring |
| Edge/Endpoint | Low latency, offline, privacy | Small models, device differences, difficult updates |

Before deployment, confirm network, identity, quota, timeout, retry, fallback, and data retention. Model APIs are not ordinary string functions; they may be delayed for several seconds, return partial content, or trigger security filtering.

### 6.1 Service Interface

Synchronous interfaces are suitable for short responses; streaming interfaces are suitable for long texts and scenarios that require feedback on the first token; asynchronous tasks are suitable for batch generation and long processes. The error semantics of different interfaces are different:

- Failed after streaming started, the client has already received partial content.
- Asynchronous tasks should be able to check status, cancel, and obtain results.
- Requests may still be executed on the server after a timeout, and an operation ID is required.

### 6.2 Automatic Scaling

GPU instance startup and model loading are slow; scaling shouldn't depend solely on the CPU. Warm-up, minimum replica, queue length, and concurrency metrics are needed. Scaling too quickly will interrupt requests, while scaling too slowly will cause backloging. 

## 7. Version governance

A model system has at least these versions: 

- Base model. 
- tokenizer.  
- Adapter/fine-tuning weights. 
- Inference engine and quantization parameters. 
- System prompts and tool schemas. 
- Retrieval indexing and embedding models. 
- Review sets and review codes. 

Versions should be rollable together. Only rolling back the model while keeping new prompts, or simply changing embedding without rebuilding the index, can create new inconsistencies. 

Release strategy: 

- Shadow traffic: Copy input into the new version without affecting users. 
- Small traffic grayscale: Compare quality, latency, errors, and cost. 
- Manual review: For high-risk tasks, the new version is first given suggestions and confirmed by people. 
- Automatic rollback: Switches back to the old version when key metrics exceed thresholds. 

## 8. Operational monitoring

Model monitoring is not just about whether the service is online: 

- Request volume, concurrency, queuing, and timeouts. 
- First token, total generation time, and token speed. 
- Input/output tokens, context truncation, and cost. 
- Tool call success rate, step count, and loop count. 
- Rejection rate, security filtering rate, and format check failure rate. 
- Search hit rate, citation rate, and no answer rate. 
- User adoption, retrial, complaint, and manual correction. 

When recording input and output, pay attention to privacy, access control, and retention period. You can balance troubleshooting and security using hash, length, desensitized fragments, and sampling traces. 

## 9. In which situations do you need to retrain or re-index

| Change | May Require |
| --- | --- |
| Document content update | Re-chunking and indexing, not necessarily retraining |
| Terminology and Fixed Format Variations | Tips, Examples, or Fine-Tweaks |
| Permissions and tenant changes | Updated metadata and search filtering |
| Embedding Model Replacement | Reconstructing Vector Index |
| Significant changes in task distribution | New evaluation set and retraining |
| Foundation Model Upgrade | Full-link regression and grayscale |
| Inference Engine / Quantization Change | Quality and Performance Regression |

Don't make minor adjustments just because "the model is poor." First, confirm whether the problem lies in retrieval, prompts, tools, data, models, or product interactions. 

## 10. Cost and capacity

The usual optimization sequence is: 

1. Reduce invalid calls and retrys. 
2. Shorten the context, keeping only the necessary evidence. 
3. Route tasks to models of different sizes. 
4. Cache stable prefixes and repeat results. 
5. Control output length and concurrency. 
6. Then consider quantization, distillation, and self-management. 

Self-hosting is not automated, which is cheaper. GPU idleness, operations, power, and engineering investment all need to be calculated. If utilization is low, managed APIs may be more economical; If access is stable, data cannot be sent externally, and there is scale, self-hosting may be more suitable. 

## 11. Pre-launch check

1. Whether the task, success criteria, and boundaries of failure are defined. 
2. Whether the evaluation set comes from a real distribution, and whether it covers no-answers and attacks. 
3. Whether prompting, retrieval, fine-tuning, and different models are compared. 
4. Whether to record models, prompts, indexes, and tool versions. 
5. Whether streaming, timeout, cancellation, and partial failure have semantics. 
6. Whether grayscale, rollback, and legacy data compatibility are supported. 
7. Whether quality, latency, cost, and user behavior are monitored. 
8. Whether privacy, permissions, content security, and auditing are verified. 
9. Do you know when to reindex and when to retrain? 
10. Can you use evaluation evidence to prove that "this upgrade is really better"?
