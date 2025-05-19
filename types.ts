// Types for Torn API response, based on examples.txt
export interface TornFactionMember {
    id: number;
    name: string;
    position: string;
    level: number;
    days_in_faction: number;
    is_revivable: boolean;
    is_on_wall: boolean;
    is_in_oc: boolean;
    has_early_discharge: boolean;
    last_action: {
        status: string;
        timestamp: number;
        relative: string;
    };
    status: {
        description: string;
        details: string;
        state: string;
        until: number;
    };
    revive_setting: string;
}

export interface TornFactionMembersResponse {
    members: TornFactionMember[];
}
