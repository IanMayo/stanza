import { Agent } from '../';
import { MUCAffiliation, MUCRole, MUCStatusCode } from '../Constants';
import * as JID from '../JID';
import { NS_HATS_0, NS_MUC, NS_MUC_DIRECT_INVITE } from '../Namespaces';
import {
    DataForm,
    IQ,
    MUCConfigure,
    MUCDestroy,
    MUCDirectInvite,
    MUCInvite,
    MUCPresence,
    MUCUnique,
    MUCUserItem,
    MUCUserList,
    Presence,
    ReceivedMessage,
    ReceivedMUCPresence,
    ReceivedPresence
} from '../protocol';

declare module '../' {
    export interface Agent {
        joinedRooms: Map<string, string>;
        joiningRooms: Map<string, string>;

        joinRoom(jid: string, nick: string, opts?: Presence): void;
        leaveRoom(jid: string, nick: string, opts?: Presence): void;
        ban(jid: string, occupant: string, reason?: string): Promise<IQ & { muc: MUCUserList }>;
        kick(jid: string, nick: string, reason?: string): Promise<IQ & { muc: MUCUserList }>;
        invite(room: string, invites: MUCInvite | MUCInvite[]): void;
        directInvite(room: string, to: string, opts?: Partial<MUCDirectInvite>): void;
        declineInvite(room: string, sender: string, reason?: string): void;
        changeNick(room: string, nick: string): void;
        setSubject(room: string, subject: string): void;
        getReservedNick(room: string): Promise<string>;
        requestRoomVoice(room: string): void;
        setRoomAffiliation(
            room: string,
            jid: string,
            affiliation: MUCAffiliation,
            reason?: string
        ): Promise<IQ & { muc: MUCUserList }>;
        setRoomRole(
            room: string,
            nick: string,
            role: MUCRole,
            reason?: string
        ): Promise<IQ & { muc: MUCUserList }>;
        getRoomMembers(room: string, opts?: MUCUserItem): Promise<IQ & { muc: MUCUserList }>;
        getRoomConfig(room: string): Promise<DataForm>;
        configureRoom(room: string, form: Partial<DataForm>): Promise<IQ & { muc: MUCConfigure }>;
        destroyRoom(room: string, opts?: MUCDestroy): Promise<IQ & { muc: MUCConfigure }>;
        getUniqueRoomName(mucHost: string): Promise<string>;
    }

    export interface AgentEvents {
        'muc:topic': MUCTopicEvent;
        'muc:invite': MUCInviteEvent;
        'muc:other': ReceivedMessage;
        'muc:declined': MUCDeclinedEvent;
        'muc:failed': Presence;
        'muc:error': Presence;
        'muc:available': ReceivedMUCPresence;
        'muc:unavailable': ReceivedMUCPresence;
        'muc:destroyed': MUCDestroyedEvent;
        'muc:leave': ReceivedMUCPresence;
        'muc:join': ReceivedMUCPresence;
    }
}

export interface MUCTopicEvent {
    topic?: string;
    room: string;
    from: string;
}
export interface MUCInviteEvent {
    from: string;
    password?: string;
    reason?: string;
    room: string;
    thread?: string;
    type: 'direct' | 'mediated';
}
export interface MUCDeclinedEvent {
    from: string;
    reason?: string;
    room: string;
}
export interface MUCDestroyedEvent {
    newRoom?: string;
    password?: string;
    reason?: string;
    room: string;
}

function isMUCPresence(pres: ReceivedPresence): pres is ReceivedMUCPresence {
    return !!pres.muc;
}

export default function(client: Agent) {
    client.disco.addFeature(NS_MUC);
    client.disco.addFeature(NS_MUC_DIRECT_INVITE);
    client.disco.addFeature(NS_HATS_0);

    client.joinedRooms = new Map();
    client.joiningRooms = new Map();

    function rejoinRooms() {
        const oldJoiningRooms = client.joiningRooms;
        client.joiningRooms = new Map();
        for (const [room, nick] of oldJoiningRooms) {
            client.joinRoom(room, nick);
        }

        const oldJoinedRooms = client.joinedRooms;
        client.joinedRooms = new Map();
        for (const [room, nick] of oldJoinedRooms) {
            client.joinRoom(room, nick);
        }
    }
    client.on('session:started', rejoinRooms);
    client.on('stream:management:resumed', rejoinRooms);

    client.on('message', msg => {
        if (msg.type === 'groupchat' && msg.hasSubject) {
            client.emit('muc:topic', {
                from: msg.from,
                room: JID.toBare(msg.from),
                topic: msg.subject || ''
            });
            return;
        }

        if (!msg.muc) {
            return;
        }

        if (msg.muc.type === 'direct-invite') {
            client.emit('muc:invite', {
                from: msg.from,
                password: msg.muc.password,
                reason: msg.muc.reason,
                room: msg.muc.jid!,
                thread: msg.muc.thread,
                type: 'direct'
            });
            return;
        }

        if (msg.muc.invite) {
            client.emit('muc:invite', {
                from: msg.muc.invite[0].from!,
                password: msg.muc.password,
                reason: msg.muc.invite[0].reason,
                room: msg.from,
                thread: msg.muc.invite[0].thread,
                type: 'mediated'
            });
            return;
        }

        if (msg.muc.decline) {
            client.emit('muc:declined', {
                from: msg.muc.decline.from!,
                reason: msg.muc.decline.reason,
                room: msg.from
            });
            return;
        }

        client.emit('muc:other', msg);
    });

    client.on('presence', pres => {
        const room = JID.toBare(pres.from);

        if (client.joiningRooms.has(room) && pres.type === 'error') {
            client.joiningRooms.delete(room);
            client.emit('muc:failed', pres);
            client.emit('muc:error', pres);
            return;
        }

        if (!isMUCPresence(pres)) {
            return;
        }

        const isSelf =
            pres.muc.statusCodes && pres.muc.statusCodes.indexOf(MUCStatusCode.SelfPresence) >= 0;
        if (pres.type === 'error') {
            client.emit('muc:error', pres);
            return;
        }
        if (pres.type === 'unavailable') {
            client.emit('muc:unavailable', pres);
            if (isSelf) {
                client.emit('muc:leave', pres);
                client.joinedRooms.delete(room);
            }
            if (pres.muc.destroy) {
                client.emit('muc:destroyed', {
                    newRoom: pres.muc.destroy.jid,
                    password: pres.muc.destroy.password,
                    reason: pres.muc.destroy.reason,
                    room
                });
            }
            return;
        }

        client.emit('muc:available', pres);
        if (isSelf && !client.joinedRooms.has(room)) {
            client.emit('muc:join', pres);
            client.joinedRooms.set(room, JID.getResource(pres.from)!);
            client.joiningRooms.delete(room);
        }
    });

    client.joinRoom = (room: string, nick: string, opts: MUCPresence = {}) => {
        room = JID.toBare(room);
        client.joiningRooms.set(room, nick);
        client.sendPresence({
            ...opts,
            muc: {
                ...opts.muc,
                type: 'join'
            },
            to: `${room}/${nick}`
        });
    };

    client.leaveRoom = (room: string, nick: string, opts: Presence = {}) => {
        client.sendPresence({
            ...opts,
            to: `${room}/${nick}`,
            type: 'unavailable'
        });
    };

    client.ban = (room: string, occupantRealJID: string, reason?: string) => {
        return client.setRoomAffiliation(room, occupantRealJID, 'outcast', reason);
    };

    client.kick = (room: string, nick: string, reason?: string) => {
        return client.setRoomRole(room, nick, 'none', reason);
    };

    client.invite = (room: string, opts: MUCInvite | MUCInvite[] = []) => {
        if (!Array.isArray(opts)) {
            opts = [opts];
        }
        client.sendMessage({
            muc: {
                invite: opts,
                type: 'info'
            },
            to: room
        });
    };

    client.directInvite = (room: string, to: string, opts: Partial<MUCDirectInvite> = {}) => {
        client.sendMessage({
            muc: {
                ...opts,
                jid: room,
                type: 'direct-invite'
            },
            to
        });
    };

    client.declineInvite = (room: string, sender: string, reason?: string) => {
        client.sendMessage({
            muc: {
                decline: {
                    reason,
                    to: sender
                },
                type: 'info'
            },
            to: room
        });
    };

    client.changeNick = (room: string, nick: string) => {
        client.sendPresence({
            to: `${JID.toBare(room)}/${nick}`
        });
    };

    client.setSubject = (room: string, subject: string) => {
        client.sendMessage({
            subject,
            to: room,
            type: 'groupchat'
        });
    };

    client.getReservedNick = async (room: string) => {
        try {
            const info = await client.getDiscoInfo(room, 'x-roomuser-item');
            const identity = info.identities[0];
            if (identity.name) {
                return identity.name;
            } else {
                throw new Error('No nickname reserved');
            }
        } catch (err) {
            throw new Error('No nickname reserved');
        }
    };

    client.requestRoomVoice = (room: string) => {
        client.sendMessage({
            forms: [
                {
                    fields: [
                        {
                            name: 'FORM_TYPE',
                            type: 'hidden',
                            value: 'http://jabber.org/protocol/muc#request'
                        },
                        {
                            name: 'muc#role',
                            type: 'text-single',
                            value: 'participant'
                        }
                    ],
                    type: 'submit'
                }
            ],
            to: room
        });
    };

    client.setRoomAffiliation = (
        room: string,
        occupantRealJID: string,
        affiliation: MUCAffiliation,
        reason?: string
    ) => {
        return client.sendIQ({
            muc: {
                type: 'user-list',
                users: [
                    {
                        affiliation,
                        jid: occupantRealJID,
                        reason
                    }
                ]
            },
            to: room,
            type: 'set'
        });
    };

    client.setRoomRole = (room: string, nick: string, role: MUCRole, reason?: string) => {
        return client.sendIQ({
            muc: {
                type: 'user-list',
                users: [
                    {
                        nick,
                        reason,
                        role
                    }
                ]
            },
            to: room,
            type: 'set'
        });
    };

    client.getRoomMembers = (room: string, opts: MUCUserItem = {}) => {
        return client.sendIQ({
            muc: {
                type: 'user-list',
                users: [opts]
            },
            to: room,
            type: 'get'
        });
    };

    client.getRoomConfig = async (room: string) => {
        const result = await client.sendIQ({
            muc: {
                type: 'configure'
            } as MUCConfigure,
            to: room,
            type: 'get'
        });
        if (!result.muc.form) {
            throw new Error('No configuration form returned');
        }
        return result.muc.form;
    };

    client.configureRoom = (room: string, form: Partial<DataForm> = {}) => {
        return client.sendIQ({
            muc: {
                form: {
                    ...form,
                    type: 'submit'
                },
                type: 'configure'
            },
            to: room,
            type: 'set'
        });
    };

    client.destroyRoom = (room: string, opts: MUCDestroy = {}) => {
        return client.sendIQ({
            muc: {
                destroy: opts,
                type: 'configure'
            },
            to: room,
            type: 'set'
        });
    };

    client.getUniqueRoomName = async function(mucHost: string) {
        const result = await this.sendIQ({
            muc: {
                type: 'unique'
            } as MUCUnique,
            to: mucHost,
            type: 'get'
        });
        if (!result.muc.name) {
            throw new Error('No unique name returned');
        }
        return result.muc.name;
    };
}
