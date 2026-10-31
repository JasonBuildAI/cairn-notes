---
title: "Large Models, Transformer, and Multimodal"
description: "Starting from neural networks and attention mechanisms, understand how large models are trained, inferred, and handle images, audio, and video."
---

Large models seem like 'input a sentence, output a passage,' but behind them is still an engineering chain that can be broken down: the text is first split into tokens, goes through multiple layers of neural network computation, yielding the probability distribution of the next token, and then gradually generated according to a decoding strategy. Understanding this chain is necessary to determine where context length, latency, cost, and errors come from.

## 1. Main Lines of AI

Artificial intelligence is not limited to a single school of thought:

- **Symbolism** writes knowledge into rules and logic, excelling at problems that are explainable and have clear boundaries, but struggling to cover the open world.
- **Connectionism** learns using large amounts of parameters and data; neural networks belong to this branch.
- **Statistical Learning** looks for patterns in data, emphasizing generalization rather than hand-crafted rules.

Early expert systems relied on manually curated rules, which were costly to maintain and hard to scale. Machine learning and deep learning delegate the learning of features and patterns to data and optimization processes. After the Transformer was proposed in 2017, it became the core structure of large language models due to its ability for parallel training and modeling long-range dependencies.

The key change in the era of large models is not only that models are bigger but also the formation of a general paradigm: 'large-scale pre-training, instruction fine-tuning, preference alignment.' The model first learns statistical structures in language and the world, then learns to complete tasks according to instructions, and finally adjusts behavior through human preferences or verifiable feedback.

## 2. What Neural Networks Learn

### 2.1 From Linear Models to Multi-Layer Networks

The simplest neuron receives an input vector `x`, multiplies it by weights `W`, adds bias `b`, and then passes it through a nonlinear activation function:

```text
y = activation(Wx + b)
```

When there are only linear layers, stacking multiple layers is still equivalent to a single linear transformation and cannot express complex relationships. Nonlinear functions such as ReLU, GELU, and Sigmoid allow the network to fit piecewise and curved decision boundaries.

A layer is composed of multiple neurons, and multiple layers stacked together form a deep network. Each layer transforms the input representation into a new feature space; shallow layers may capture local patterns, while deeper layers combine them into more abstract structures.

### 2.2 Loss Function

A numerical value is used to measure the gap between the model output and the target, which is the loss. Common losses:

- Regression uses mean squared error.
- Classification uses cross-entropy.
- Language models predicting the next token also use cross-entropy: the higher the probability of the correct token, the smaller the loss.

The goal of training is not to make the output of a single sample "look right," but to reduce the average loss over the entire training distribution by optimizing the parameters.

### 2.3 Backpropagation and Gradient Descent

```text
Forward computation prediction
  → Calculate loss
  → Use backpropagation to compute the gradient for each parameter
  Update parameters in the opposite direction of the gradient
  Repeat
```

Gradients represent how sensitive the loss is to changes in parameters. A learning rate that is too high can cause oscillations or divergence, while a rate that is too low results in slow training. In practice, training uses optimizers like Adam/AdamW, learning rate scheduling, weight decay, gradient clipping, and mixed precision.

### 2.4 Training, Validation, and Testing

- The training set is used to update parameters.
- The validation set is used to select hyperparameters and for early stopping.
- The test set is used for final evaluation and should not be used repeatedly for model tuning.

When a model performs well on the training set but poorly on new data, it is called overfitting. Increasing data, regularization, Dropout, data augmentation, reducing model complexity, or early stopping can help alleviate it. Conversely, if the model cannot even perform well on the training set, it is called underfitting, which requires stronger expressiveness or better features.

### 2.5 Generalization and Distribution Shift

A model can only learn patterns from the data distribution it has seen. When real-world inputs shift, performance may degrade:

- New domain vocabulary.
- New user behaviors.
- Changes in devices, regions, or languages.
- Label bias in the training data.

Good offline metrics do not necessarily translate to online effectiveness. Evaluation sets that closely match real tasks should be established, and input distributions and output quality should be continuously monitored.

## 3. Core of Transformers

### 3.1 Tokens and Vocabulary

Models do not handle characters directly. Tokenizers split text into tokens, which are then mapped to integer IDs. A token can be a word, subword, punctuation, or part of a Chinese character.

```text
"transformer model" → ["trans", "former", " model"] → [...]
```

Different models have different tokenizers and vocabularies. The number of tokens is not equal to the number of characters or words. The token cost for Chinese, code, spaces, and rare symbols may vary, and the context limit is also calculated in tokens.

### 3.2 Embedding

Each token ID is converted into a vector through an embedding table. The vector representation encodes learnable semantic features. Positional information also needs to be added because pure attention itself doesn't know the order; modern models often use Rotary Positional Encoding (RoPE) or learnable positional vectors.

### 3.3 Self-Attention

Each token generates three vectors: Query, Key, and Value:

```text
Attention(Q, K, V) = softmax(QKᵀ / √dₖ) V
```

It can be understood like this:

- Query represents "what information I am looking for."
- Key represents "what features I can provide."
- The dot product of Query and Key measures relevance.
- Softmax turns relevance into weights.
- Use the weights to weight the Value and obtain the new representation of the current token.

The `√dₖ` is just to prevent the dot product from being too large after increasing dimensions, which would make softmax too sharp. Causal language models use masking so that the current position can only see itself and preceding tokens, and cannot peek at the future.

### 3.4 Multi-Head Attention

A single attention can only learn one type of relationship. Multi-head attention uses multiple sets of Q/K/V computed in parallel, then concatenated and projected, allowing the model to simultaneously focus on different patterns such as syntax, coreference, position, and semantics.

### 3.5 Feedforward Networks and Residuals

Each Transformer block typically contains:

```text
Input
  Multi-head attention
  → Residual Connection  + LayerNorm
  Feedforward Network (FFN)
  → Residual Connection  + LayerNorm
```

FFN performs nonlinear transformations independently at each position, and its parameters often account for a large proportion. Residual connections help gradients and information pass through deep networks, and normalization stabilizes training.

### 3.6 Encoder, Decoder, and Variants

- The Encoder sees the entire input simultaneously, suitable for understanding, classification, and representation.
- The Decoder uses causal masking to generate step by step, suitable for language models.
- Encoder-Decoder is suitable for input-to-output tasks like translation and summarization.

Modern generative large models often use a decoder-only structure. Different structures are not about "which is more advanced," but rather about the task and training objectives.

### 3.7 Attention Complexity

The computation of standard self-attention grows approximately quadratically with sequence length. Doubling the context may significantly increase attention computation and memory pressure. Long-context optimizations include sparse attention, chunking, linear approximations, KV compression, and better cache management, but they cannot completely eliminate the information selection problem.

## 4. How Large Models Are Trained

### 4.1 Pre-training

The basic task of a language model is to predict the next token. Given the preceding context, the model outputs the probability of each token in the vocabulary. During training, the negative log-likelihood of the correct token is minimized:

```text
loss = -log P(correct token | previous context)
```

Massive amounts of text allow models to learn language, code, common sense, and some reasoning patterns. Pre-training data quality, deduplication, proportion, copyright, and privacy directly affect capabilities and risks. 

### 4.2 Scaling Rules

Within a certain range, increasing parameter size, data size, and computation load can reduce losses, but the benefits are not unlimited. When data is insufficient, no matter how many model parameters there are, training will still be undertrained; Poor data quality amplifies noise. Actual training requires trade-offs between model size, training tokens, inference cost, and latency. 

### 4.3 Instruction Fine-tuning

Pre-trained models continue text but do not necessarily act according to user instructions. Supervised Fine-Tuning (SFT) trains models with "instruction-ideal answer" samples, teaching them task formatting, rejecting boundaries, and multi-turn dialogue. 

### 4.4 Preference alignment

Humans can judge "which answer is better" for preference optimization: 

- RLHF trains the reward model, then uses reinforcement learning to optimize the strategy. 
- DPO directly optimizes the model based on preferences, making the process simpler. 
- Verifiable tasks can be rewarded with rules, unit tests, or tool results. 

Alignment is not a one-time task, nor does it guarantee that models will always follow rules. Data coverage, assessment, security policies, and runtime constraints remain necessary. 

### 4.5 Efficient Fine-Tuning of Parameters

Full-parameter training requires a large amount of video memory. Methods like LoRA freeze the original model and only train low-rank fit matrices; Adapters and prefix fine-tuning are also parameter-efficient methods. They reduce training and storage costs, but their effectiveness depends on data quality, task distance, and hyperparameters. 

## 5. Reasoning and generation

### 5.1 From logits to tokens

Each step of the model outputs logits from the vocabulary, which is converted into probability by softmax. During generation, it does not directly select the "most correct sentence" but selects one token at a time, then returns the result to the input to continue. 

Common decoding strategies: 

- **Greed**: Takes the token with the highest probability at each step, stable but may be repeated or localized. 
- **Temperature Sampling**: Higher temperatures are more random, lower temperatures more concentrated. 
- **Top-k**: Only samples from the k tokens with the highest probability. 
- **Top-p/Kernel Sampling**: Samples are taken from the smallest set with cumulative probability reaching p. 
- **Beam Search**: Retains multiple candidate paths, commonly used for deterministic tasks such as translation. 

Temperature, top-k, and top-p affect style and stability, but do not guarantee the accuracy of the facts. Structured tasks should use schema/constraint decoding or post-validation. 

### 5.2 KV Cache

During autoregressive generation, the Key/Value from previous texts can be cached, avoiding recalculating the entire context at every step. KV cache significantly reduces computation, but memory grows with context length, layers, headers, and batch size. Long contexts and high concurrency quickly fill up the memory. 

### 5.3 Context Window

The context window is the total token budget the model can see at one time, including system prompts, user input, history, retrieved content, tool results, and output. A larger window does not mean all content is useful; attention becomes scattered, delays increase, and costs increase. 

### 5.4 Hallucination

The model generates probabilistically reasonable text, not database queries. Hallucinations may come from: 

- Missing or conflicting training data. 
- Questions that go beyond the boundaries of knowledge. 
- Prompt requests to force a response. 
- Insufficient or neglected search evidence. 
- Decoding randomness and long chain error accumulation. 

Reducing hallucinations relies on searching, citations, tool validation, rejection strategies, structured output, and evaluation, rather than just writing "Don't talk nonsense" in prompts. 

## 6. Embedding and vector retrieval

Embedding maps text, images, or other objects as vectors, making objects with similar meanings closer together in vector space. Common uses: 

- Semantic search. 
- Clustering and deduplication. 
- Recommendations and similar content. 
- RAG search. 

Common distance metrics include cosine similarity, inner product, and Euclidean distance. The training objectives of the models differ, and whether vectors can be directly compared depends on the model and normalization method. 

Vector indexes are used for approximate nearest neighbor search: 

- HNSW builds multi-layer graphs, enabling fast queries and high memory usage. 
- IVF clusters first and then searches for some clusters, with adjustable recall and speed. 
- Quantizing compression vectors reduces memory but loses precision. 

Vector search is not universal semantic search. Numbers, proper nouns, and exact matching often still require keyword searches, while actual systems often use mixed searches. 

## 7. Multimodal models

### 7.1 Visual-Language Models

A common approach is to extract image features using a vision encoder, then map them through a projection layer into a representation space that the language model can process. The model can answer image questions, describe content, or reason by combining images and text. 

Visual input involves resolution and token cost. High-resolution images may be split into multiple patches; the more details there are, the greater the computation and context consumption. 

### 7.2 Image Generation

The diffusion model starts with noise and generates images through multi-step denoising. Text conditions are injected by encoders to guide the direction of generation. Key concepts include: 

- Noise is added to images during training, and the model learns to predict noise. 
- Gradually denoising random noise during inference. 
- The number of sampling steps affects quality and speed. 
- Condition strength affects the degree of text constraint. 
- Seed effects are reproducible, but changes in models and parameters also alter the results. 

Image generation also involves handling copyright, portraits, deepfakes, security filtering, and content traceability. 

### 7.3 Video Generation

Video can be seen as a sequence of images continuously over time. Models need to maintain frame consistency, object identity, movement, and camera logic. Computational load, timing modeling, and long-form video stability are all more challenging; common practices include spatiotemporal attention, latent space compression, and segmented generation. 

### 7.4 Speech Recognition and Synthesis

- ASR converts audio to text, focusing on sampling rate, noise, accent, punctuation, and timestamps. 
- TTS converts text to speech, focusing on naturalness, rhythm, timbre, and latency. 
- Streaming voice needs to handle segmentation, endpoint detection, interrupts, and first-packet delays. 
- Voice cloning involves identity and abuse risks and must have authorization and security restrictions. 

### 7.5 Native Multimodality

Native multimodal models jointly process text, images, audio, and other inputs within the same model, rather than simply linking multiple single-modal models in series. They can share representations, but training data, alignment, and evaluation are more complex. Engineering-wise, chains still need to be split by input/output, latency, and cost. 

## 8. Ability map

| Capability | Strengths | Cannot Replace |
| --- | --- | --- |
| Text Understanding and Generation | Summarization, paraphrasing, classification, conversation | Authoritative factual sources |
| Code | Generation, explanation, refactoring, test suggestions | Compilation, execution, and verification |
| Reasoning | Multi-step analysis, planning, constraint-solving assistance | Formal proofs and real-world states |
| Tool Use | Querying, calculation, operating external systems | Permissions, idempotency, and security boundaries |
| Vision | Image description, OCR, visual Q&A | High-precision measurement and professional judgment |
| Speech | Transcription, synthesis, conversation | Absolute reliability in noisy environments |
| Media Generation | Image, video, audio creation | Copyright, authenticity, and ethical review |

Choose models not just based on rankings. Break down tasks:

1. Do you need text, code, image, or audio?
2. Which matters more: quality, latency, context, privacy, or cost?
3. Are external APIs allowed, and can data leave the local environment?
4. Do you need structured output and tool usage?
5. How do you evaluate with real tasks rather than just demos?

## 9. Common Misunderstandings

- **The model knows everything that happened after training**: Knowledge is limited to training data's timeframe and may be inaccurate.
- **Bigger context is always better**: Costs and distractions increase; the key is selecting useful information.
- **Lower temperature is more correct**: Low temperature is more stable but does not fix missing knowledge.
- **Model output equals a database record**: Verification, citation, or tool queries are necessary.
- **Multimodal equals true understanding**: Models may rely on text shortcuts and surface patterns.
- **Bigger parameter count is always better**: Latency, cost, deployment environment, and task fit are equally important.

## Checklist

- Do you understand tokenizer, context window, and token costs?
- Can you explain Q/K/V in attention and causal masking?
- Can you distinguish pretraining, instruction tuning, preference alignment, and parameter-efficient fine-tuning?
- Do you understand how temperature, top-k, top-p affect output?
- Do you understand KV cache and long-context costs?
- Can you reduce hallucinations via retrieval, tools, and evaluation rather than just changing prompts?
- Do you choose models according to tasks: text, vision, speech, or generative?
- Do you check data, copyright, privacy, and multimodal content safety?
