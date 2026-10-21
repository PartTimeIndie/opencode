export declare function context(sessionID?: string, fingerprint?: string): {
    version: number;
    capturedAt: number;
    fingerprint: string;
    session: {
        id: string;
        directory: string;
        title: string;
    };
    activity: {
        status: string;
        working: boolean;
    };
    boundaryComplete: boolean;
    selection: string;
    messages: {
        id: string;
        role: string;
        complete: boolean;
        text: string;
        createdAt: number;
    }[];
    pending: {
        questions: {
            id: string;
            revision: number;
            items: {
                text: string;
                context: string;
                fields: never[];
                options: never[];
            }[];
        }[];
        permissions: never[];
        controls: never[];
    };
    totals: {
        messages: number;
        textChars: number;
        questions: number;
        controls: number;
        permissions: number;
    };
    truncated: {
        messages: boolean;
        text: boolean;
        pending: boolean;
    };
};
export declare function fixture(overrides?: {}): {
    api: {
        signal: AbortSignal;
        settings: {
            get: (key: any, fallback: any) => any;
            subscribe(fn: any): () => boolean;
        };
        host: {
            sessions: {
                context(input: any): Promise<{
                    ok: boolean;
                    context: {
                        version: number;
                        capturedAt: number;
                        fingerprint: string;
                        session: {
                            id: string;
                            directory: string;
                            title: string;
                        };
                        activity: {
                            status: string;
                            working: boolean;
                        };
                        boundaryComplete: boolean;
                        selection: string;
                        messages: {
                            id: string;
                            role: string;
                            complete: boolean;
                            text: string;
                            createdAt: number;
                        }[];
                        pending: {
                            questions: {
                                id: string;
                                revision: number;
                                items: {
                                    text: string;
                                    context: string;
                                    fields: never[];
                                    options: never[];
                                }[];
                            }[];
                            permissions: never[];
                            controls: never[];
                        };
                        totals: {
                            messages: number;
                            textChars: number;
                            questions: number;
                            controls: number;
                            permissions: number;
                        };
                        truncated: {
                            messages: boolean;
                            text: boolean;
                            pending: boolean;
                        };
                    };
                }>;
            };
            ai: {
                run(input: any): Promise<{
                    ok: boolean;
                    text: string;
                }>;
            };
            tts: {
                speak(input: any): Promise<{
                    ok: boolean;
                    stream: ReadableStream<any>;
                    format: string;
                }>;
            };
        };
    };
    player: {
        unlock(): Promise<void>;
        decode(): Promise<{
            buffer: string;
        }>;
        playBuffer(buffer: any): Promise<void>;
        stop(): void;
    };
    controller: unknown;
    calls: {
        ai: never[];
        tts: never[];
        read: never[];
        played: never[];
        stopped: number;
    };
    owner: AbortController;
    change(change: any): void;
};
