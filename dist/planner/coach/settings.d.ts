export interface UserSettings {
    skipCoach?: boolean;
    lastCoachedAt?: number;
    coachModel?: string;
    coachProviderId?: string;
}
export declare function loadUserSettings(): UserSettings;
export declare function saveUserSettings(s: UserSettings): void;
