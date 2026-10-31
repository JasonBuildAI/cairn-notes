---
title: "A One-Page Guide to Computer Systems"
description: "From transistors, operating systems, and networks to data structures and compilers, build a system map that can locate problems."
---

This page does not aim to condense computer science courses into a few conclusions, but rather to place concepts that will repeatedly appear later in the correct context: where a program gets its computing power, which layer stores the data, how the operating system isolates processes, how networks connect two machines, and how source code turns into executable actions.

You don't need to know how to design a CPU or write a compiler by hand, but you must know at which layer an event occurs. Otherwise, when you see "the service is slow," you can only guess randomly between reinstalling dependencies, changing code, and restarting the server.

## 1. From Transistors to CPU

The lowest level of a computer uses controllable switches. Transistors can represent on and off states and can be combined to form logic gates such as AND gates, OR gates, and NOT gates; logic gates then construct adders, registers, selectors, and control circuits. Only when many circuits work together can a processor capable of executing instructions be formed.

A CPU does not need to understand "user," "file," or "web page." It only does one repetitive task: fetch the instruction, decode it, execute it, write back, and then proceed to the next one. This cycle is called the **instruction cycle**.

```text
Fetch instruction → Decode → Fetch operands → Execute → Write back → Update next address
```

The instruction set that a CPU can execute is called the **Instruction Set Architecture (ISA)**. CISC tends to use more complex, variable-length instructions; RISC tends to use simple, regular instructions, assigning complex operations to multiple instructions or compilers. The two are not "absolutely faster," but rather a design trade-off. 

Modern CPUs also use pipelines: overlapping stages like finger retrieval, decoding, and execution, so that different instructions are at different stages at the same time. Pipelines encounter three types of risks: 

- **Structural Risk**: Two stages compete for the same hardware resource. 
- **Data Risking**: The next instruction requires the result of the previous one that has not yet been written. 
- **Control Risk**: Branch jumps make the CPU unsure where to take the next line. 

Branch prediction, out-of-order execution, and multicore parallelism are all built on the goal of "minimizing the pipeline from stopping." Multicore improves parallelism, but shared memory, cache consistency, and locks also introduce new complexities. 

## 2. Storage tier: The speed difference between the CPU and the real world

The speed and capacity of storage at each computer layer vary greatly. Registers are the fastest but very few, cache is second, memory is larger and slower, SSDs and mechanical drives are slower, and cross-network access can be several orders of magnitude slower. 

| Hierarchy | General Role | Project Meaning |
| --- | --- | --- |
| Register | Value currently used by the CPU | Compiler and instruction scheduling |
| L1/L2/L3 cache | Hotspot data and instructions | Sequential access and data locality are very important |
| Main memory | Current process workspace | Insufficient memory may cause page changes or even process death |
| SSD / HDD | Persistent files and databases | Random read/write, sequential write, and fsync have different costs |
| Network and Remote Storage | Data on Other Machines | Latency, packet loss, timeout, and bandwidth are the main issues |

Caches are usually read by **cache rows** rather than just one byte. Sequential traversal of arrays is often faster than randomly chasing linked list nodes, as the former better utilizes spatial locality. Database indexing, log appendages, and columnar storage essentially optimize data access patterns. 

The CPU uses virtual addresses when accessing memory. **Virtual Memory** allows each process to see continuous, independent address spaces, and the operating system and hardware map virtual pages to physical pages via page tables. When page table entries are not cached, TLB must be checked. This way, processes do not need to know which physical memory block occupies each other, and it is difficult to access them directly beyond boundaries. 

When memory pressure becomes too high, the system will move pages that are temporarily unused to disk. If page changes happen frequently, the program may appear to be running but may actually slow down to the point of freezing. This is why "seeing low CPU usage" does not prove the service is healthy. 

## 3. Operating system: Packaging hardware as available resources

The operating system mainly manages four types of resources: CPU, memory, files and devices, and network. It provides both isolation and abstraction, allowing applications to operate hardware directly. 

### 3.1 Kernel Mode, User Mode, and System Calls

Ordinary programs run in user mode and cannot arbitrarily access hardware or other process memory. When reading or writing files, creating processes, accessing the network, or requesting memory, programs request kernel execution via **system calls**. A single system call means privilege-level switching, not a regular function call; High-frequency small system calls may become performance bottlenecks. 

### 3.2 Processes and Threads

**Processes** are the basic units of resource isolation, holding address space, open files, environment variables, and permissions. **Threads** are CPU scheduling units, where threads within the same process share address space and file resources. 

By default, processes are isolated; communication requires pipes, shared memory, sockets, or messaging systems. Sharing memory between threads is more convenient, but when sharing variable data, synchronization is required; otherwise, race conditions, deadlocks, or data corruption may occur. 

The operating system scheduler determines which threads run and when. Time slice rotation is just the most intuitive model; Real scheduling considers priority, wait time, CPU affinity, and I/O blocking. When the number of threads far exceeds the number of CPU cores, context switching and queuing costs increase. 

### 3.3 File System

The file system organizes data blocks into directories, files, permissions, and metadata. Paths are abstracts as seen by users; At the underlying level, there are inodes, block allocation, logs, caches, and mount points. Opening a file gives you a file descriptor, which is a handle within the process, not just a "path string." 

Writing files is not automatically equivalent to secure disk placement. Application writes, operating system page caching, disk caching, and `fsync` control different stages. Databases need to clearly balance between "performance" and "not losing promised data after power outage." 

### 3.4 Signal and Process Lifecycle

Processes can be started, suspended, terminated, or receive signals. For example, `SIGINT` is often sent by `Ctrl+C`, `SIGTERM` requests process exit normally, `SIGKILL` is forcibly terminated. After receiving a termination signal, the service should first stop accepting new requests, complete or cancel the task being processed, and then close the connection. 

## 4. From pressing the power button to opening the browser

Boot can be connected into a single path, but each segment can be checked individually:

```text
Power Supply and Firmware (UEFI)
    Find startup device
Boot Loader
    Loading kernel
Operating system kernel initialization
    Start the first user-mode process
init / systemd start service
    ↓ Pull up login, desktop, network
The browser makes the first request
```

Firmware is responsible for the most basic hardware initialization and finding bootable devices. The bootloader reads the kernel into memory. The kernel establishes memory management, the scheduler, drivers, and the file system, and then starts the user-space init. Init systems like systemd start network, logging, database, and application services according to dependencies.

Desktop environments, browsers, proxies, and DNS are at higher layers. Issues like a system "black screen," "SSH not connecting," "services not starting," or "webpage 502" belong to completely different fault layers and should not all be approached with the same "try reinstalling" first step.

## 5. How Data is Represented

Computers ultimately only handle bits and bytes. A byte is 8 bits and can represent values from 0 to 255. Characters, integers, floating-point numbers, images, and programs are all ways of interpreting bytes.

### 5.1 Text Encoding

ASCII only covered early English characters. Unicode assigns code points to the world's characters, and UTF-8 encodes code points into 1 to 4 bytes. UTF-8 is compatible with ASCII and English characters still take only one byte, making it the default choice for the Web and most source code.

"Character count" and "byte count" are not the same thing. A Chinese character usually takes 3 bytes in UTF-8; in JavaScript strings and some other languages, it may also be counted in UTF-16 code units. When handling length limits, truncation, and database fields, it is important to be clear whether the unit is characters, code points, or bytes.

### 5.2 Numbers and Floating Point

Integers have digit width, sign, and overflow issues. Unsigned integers cannot represent negative numbers; the behavior of signed integers after overflow depends on the language and runtime. Special attention should be paid to precision and range for timestamps, amounts of money, and IDs.

Floating-point numbers approximate real numbers using formats like IEEE 754 and cannot represent all decimal fractions exactly. `0.1 + 0.2 !== 0.3` is not a "language bug," but a normal result of binary floating-point. Amounts of money usually use integers of the smallest currency unit or decimal fixed-point types; IDs that require exact comparison should not rely on floating-point.

### 5.3 Media and Compression

Images usually store pixels, color space, and compression information; audio records waveforms according to sample rate and bit depth; video consists of frames, encoding parameters, and timestamps. Differences among JPEG, PNG, and WebP are not just file names—the compression method, transparency channel, and applicable scenarios all differ.

Compression can be lossless or lossy. Lossless requires complete restoration upon decoding and is suitable for source code and configuration; lossy discards some information in exchange for smaller file size and is suitable for photos and audio. Checksums or hashes are also commonly used during transmission to detect corruption, but a checksum can only prove whether the content has changed, not the source's authenticity.

## 6. Networking: How Data Moves Across Machines

Network protocols can be understood in layers, but it is not necessary to start from the OSI seven layers. In practice, engineers more often ask: how does a domain name become an IP, how does a packet reach a host, which process receives it, is the connection reliable, and what is the format of the application-layer message?

```text
URL → DNS Analysis → IP and Ports
    → TCP/UDP Transmission
    → TLS (at HTTPS)
    → HTTP Request/Response
    → Browser or client processing
```

DNS translates domain names into IP addresses. IP is responsible for delivering packets to the target host, and ports hand the traffic over to specific processes. TCP provides an ordered, reliable, connection-oriented byte stream, suitable for HTTP and databases; UDP does not guarantee delivery or order, but the overhead is low, making it suitable for real-time audio and video, games, and some DNS queries.

HTTP is an application layer protocol that defines methods, paths, headers, status codes, and message bodies. HTTPS adds TLS between HTTP and TCP to complete authentication, key negotiation, and encryption. TLS is not as simple as "encrypting the entire website"; certificate chains, domain matching, expiration times, proxy termination, and protocol versions all affect the result.

Latency and bandwidth are two different metrics. Bandwidth determines how fast large files can be transferred, while latency determines the time for a single round trip. When there are many small requests, the number of round trips and queuing is often more important than bandwidth.

## 7. Data Structures and Algorithms: Choose Structures for Access Patterns

Data structures are not just a checklist for interviews, but an answer to "how the data is accessed."

| Structure | Typical Operations | Advantages | Cost |
| --- | --- | --- | --- |
| Array | Index access, traversal | Contiguous memory, cache-friendly | Insertion and deletion in the middle require shifting |
| Linked List | Insert/delete after known node | Flexible structure | Poor random access, high pointer overhead |
| Stack | Last-in-first-out | Call stack, parsing, undo | Only suitable for restricted access order |
| Queue | First-in-first-out | Task scheduling, message buffering | May backlog, requires backpressure |
| Hash Table | Lookup by key | Fast average lookup | Unordered, collisions, memory overhead |
| Binary Search Tree | Ordered lookup and range queries | In-order traversal is ordered | Can degrade when unbalanced |
| Heap | Retrieve max/min value | Priority queue, scheduling | Does not support efficient arbitrary lookup |
| Graph | Relationships between nodes and edges | Paths, dependencies, social networks | Complex storage and traversal |
| Inverted Index | Keyword → documents | Full-text search | Cost in construction, updating, and storage |

Complexity describes how cost grows as input increases. Binary search requires ordered data, discards half each time, time complexity is `O(log n)`; hash table average `O(1)` lookup assumes a reasonably uniform hash distribution and no serious collisions. Big O does not include constants, nor consider network and disk, so in engineering you must also consider actual data size, cache hits, and access patterns.

Recursion breaks a problem into similar subproblems and must define termination conditions, otherwise it can cause stack overflow. Greedy algorithms make the locally optimal choice at each step, which only guarantees global optimum if the problem satisfies certain properties. Sorting, searching, graph traversal, and dynamic programming are common tools, but most business systems prefer using mature libraries rather than hand-writing algorithms.

## 8. Language, Compilation, and Types

Source code itself is just text. The language runtime or compiler determines how it is transformed into machine-executable operations.

A typical compilation process is:

```text
Source code → Lexical analysis → Syntax analysis → AST
     → Semantic Analysis → Intermediate Representation → Optimization → Target Code
```

**Lexical Analysis** breaks the character stream into tokens; **Syntax Analysis** constructs the abstract syntax tree (AST) according to the grammar; **Semantic Analysis** checks names, scopes, and types; the optimization stage reduces computation without changing program semantics; finally, machine code, bytecode, or other intermediate representations are generated.

Compiled languages generally complete most of the translation before running, interpreted languages are executed by the interpreter as they read, and JIT compiles hot code into machine code at runtime. The boundaries in modern languages are blurred: Java uses bytecode and JIT, JavaScript engines optimize hot functions, and Python also has multiple compilation and acceleration paths.

Memory management is divided into manual management and automatic garbage collection modes. Reference counting can release memory promptly but may encounter circular references; tracing GC can handle cycles but may cause pauses and extra memory usage. Languages like Rust constrain memory use at compile time through ownership and borrowing checks, at the cost of learning and coding complexity.

Type systems are used to catch some errors at compile-time or during static analysis. Static typing, dynamic typing, strong typing, and weak typing are not four mutually exclusive labels. TypeScript is statically typed, but the types basically disappear after compilation; Python has type hints, but runtime checks are still required. Any data from the network, files, environment variables, or user input cannot be assumed valid based solely on type annotations.

## 9. Use This Map to Troubleshoot Problems

Suppose a webpage loads very slowly, you can narrow the scope layer by layer:

| Phenomenon | Check This Layer First | Evidence |
| --- | --- | --- |
| Domain resolution failure | DNS | `dig` / `nslookup`, resolution records |
| Connection refused | Port, process, firewall | Listening addresses, `curl -v`, security group |
| TLS errors | Certificate, time, proxy | Certificate chain, expiration, SNI |
| Slow requests | Network, service, database | Time spent at each stage, traces, slow queries |
| Service consuming full CPU | Algorithm, loops, concurrency | Profiler, flame graphs, thread states |
| Memory continuously increasing | Cache, object lifetime | Heap snapshots, GC metrics |
| Sporadic errors | Concurrency, retries, dependencies | Log context, request ID, metrics |

First determine the layer, then choose the tool. Do not restart, clear caches, reinstall dependencies, and change code simultaneously without evidence; this may destroy the actual fault context.

## Key Takeaways from This Page

1. Computers are composed hierarchically: transistors and logic gates → CPU → memory and I/O → operating system → network → applications.  
2. The speeds of computation, memory, disk, and network vary greatly, so performance issues should first consider where data is and how frequently it is accessed.  
3. Processes provide isolation, threads provide concurrency; shared state must be synchronized, and asynchronous does not mean parallel.  
4. Bytes, characters, integers, and floating points are different concepts; at boundaries, encoding and precision must be verified.  
5. For network issues, first distinguish DNS, connection, TLS, HTTP, and service handling.  
6. The value of a data structure depends on the access pattern; complexity must be considered alongside real constants and I/O.  
7. Type checking can only catch part of the errors; runtime input must still be validated.
