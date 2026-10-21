export declare const VOICE_TIMING: {
    previewWindowMs: number;
    previewOverlapMs: number;
    playbackTimeoutMs: number;
};
export declare function createPermissionQueue(): {
    readonly current: any;
    ask(event: any): void;
    replied(requestID: any): void;
    clear(): void;
    reply(reply: any, send: any): Promise<any>;
};
export declare function resolveModelTargetRequest(value: any, message: any): {
    model: string;
    chain?: undefined;
} | {
    model?: undefined;
    chain: string;
};
export declare function prepareVoiceTurn(value: unknown): { text: string; confirmations: string[]; verbosity?: "concise" | "detailed"; speedDelta?: number; };
export declare function voicePrompt(text: string, verbosity?: "concise" | "detailed"): string;
export declare function matchReleasePhrase(input: { transcript: string; phrase: string; pending: boolean; userOnset: boolean; playbackActive: boolean; }): boolean;
export declare function drainSpeechSentences(value: any, flush?: boolean): {
    sentences: string[];
    remainder: string;
};
export declare function rms(samples: any): number;
export declare function advanceVoiceTurn(state: any, samples: any, threshold: any, silenceLimit: any): {
    speaking: any;
    silenceSamples: any;
    shouldFinish: boolean;
};
export declare function mergeSamples(chunks: any): Float32Array<any>;
export declare function wavBlob(samples: any, sampleRate: any): Blob;
export declare function pcm16le(bytes: any): Float32Array<ArrayBuffer>;
