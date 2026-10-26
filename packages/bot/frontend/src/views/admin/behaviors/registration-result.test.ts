import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/client';
import { registrationFailure, registrationResult } from './registration-result';

const t = (key: string, named?: Record<string, unknown>) => (named ? `${key} ${JSON.stringify(named)}` : key);
const names = new Map([['123456789012345678', 'tutor']]);

describe('registrationResult — what a command write did on Discord', () => {
    it('registered on every target is a success, per target', () => {
        const r = registrationResult(t, { status: 'registered', targets: [{ target: 'global', status: 'patched' }] }, names);
        expect(r.tone).toBe('ok');
        expect(r.headline).toBe('behaviors.registration.registered');
        expect(r.targets).toEqual([
            { target: 'behaviors.registration.target.global', text: 'behaviors.registration.outcome.patched' },
        ]);
    });

    it('a guild the bot cannot reach is a warning, named by the guild', () => {
        const r = registrationResult(
            t,
            { status: 'registered', targets: [{ target: 'guild:123456789012345678', status: 'skipped', reason: 'guild_unavailable' }] },
            names,
        );
        expect(r.tone).toBe('warn');
        expect(r.targets[0]).toEqual({ target: 'tutor', text: 'behaviors.registration.outcome.skipped' });
    });

    it('deferred says it is saved but not on Discord yet, with the reason', () => {
        const r = registrationResult(t, { status: 'deferred', reason: 'the bot is not connected to Discord' }, names);
        expect(r.tone).toBe('warn');
        expect(r.headline).toBe('behaviors.registration.deferred');
        expect(r.detail).toBe('the bot is not connected to Discord');
    });

    it('removed says the command left Discord', () => {
        const r = registrationResult(t, { status: 'removed' }, names);
        expect(r.headline).toBe('behaviors.registration.removed');
        expect(r.targets).toEqual([]);
    });
});

describe('registrationFailure — a refused registration is never shown as success (#107)', () => {
    it('shows the real error and each failed target', () => {
        const err = new ApiError(502, 'Discord did not accept /nas: Missing Access', 'registration_failed', null, {
            targets: [{ target: 'guild:123456789012345678', status: 'failed', attempted: 'patch', error: 'Missing Access' }],
        });
        const r = registrationFailure(t, err, names);
        expect(r.tone).toBe('danger');
        expect(r.headline).toBe('behaviors.registration.failed');
        expect(r.detail).toBe('Discord did not accept /nas: Missing Access');
        expect(r.targets).toEqual([
            { target: 'tutor', text: 'behaviors.registration.outcome.failed', detail: 'patch: Missing Access' },
        ]);
    });

    it('any other refusal is shown as that refusal', () => {
        const r = registrationFailure(t, new ApiError(404, 'command 4 does not exist', 'not_found'), names);
        expect(r.tone).toBe('danger');
        expect(r.headline).toContain('behaviors.errors.not_found');
        expect(r.targets).toEqual([]);
    });

    it('a malformed details body still shows the message', () => {
        const err = new ApiError(502, 'boom', 'registration_failed', null, { targets: 'nope' });
        expect(registrationFailure(t, err, names).targets).toEqual([]);
    });
});
