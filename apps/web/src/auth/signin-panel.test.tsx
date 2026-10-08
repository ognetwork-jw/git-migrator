// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json' with { type: 'json' };
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { AuthErrorView } from './auth-error-view.tsx';
import { SignInPanel } from './signin-panel.tsx';

vi.mock('next/navigation', () => ({ usePathname: () => '/signin', useRouter: () => ({}) }));

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchReturning = (response: Response) =>
  vi.fn(async () => response) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

beforeEach(() => {
  installMatchMedia(false);
});
afterEach(cleanup);

describe('SignInPanel', () => {
  it('[UI-036] offers the Entra button and no test form by default', () => {
    renderWithApp(<SignInPanel next="/" testSignIn={false} />);
    expect(screen.getByRole('heading', { name: 'Sign in to git-migrator' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('[UI-036] shows the test sign-in form when it is enabled', () => {
    renderWithApp(<SignInPanel next="/" testSignIn />);
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByText(messages.auth.signin.testNotice)).toBeTruthy();
  });

  it('[UI-036] the Entra button follows the authorize URL the server returns', async () => {
    const navigate = vi.fn();
    const fetchImpl = fetchReturning(reply(200, { url: 'https://login.example/authorize' }));
    renderWithApp(
      <SignInPanel next="/waves" testSignIn={false} navigate={navigate} fetchImpl={fetchImpl} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://login.example/authorize'));
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).callbackURL).toBe('/waves');
  });

  it('[UI-036] a refused Entra start shows the text of its auth error code', async () => {
    const fetchImpl = fetchReturning(reply(400, { code: 'sign_in_method_not_allowed' }));
    renderWithApp(
      <SignInPanel next="/" testSignIn={false} fetchImpl={fetchImpl} navigate={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }));
    expect(await screen.findByText(messages.auth.error.sign_in_method_not_allowed)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeTruthy();
  });

  it('[UI-036] an unknown error code falls back to the generic text', async () => {
    const fetchImpl = fetchReturning(reply(400, { code: 'title' }));
    renderWithApp(
      <SignInPanel next="/" testSignIn={false} fetchImpl={fetchImpl} navigate={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }));
    expect(await screen.findByText(messages.auth.error.unknown)).toBeTruthy();
  });

  it('[UI-036] test sign-in needs both fields, then posts them and follows next', async () => {
    const navigate = vi.fn();
    const fetchImpl = fetchReturning(reply(200));
    renderWithApp(
      <SignInPanel next="/waves" testSignIn navigate={navigate} fetchImpl={fetchImpl} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(messages.auth.signin.emailRequired)).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@test.local' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-test-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/waves'));
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({ email: 'admin@test.local' });
  });

  it('[UI-036] refused test credentials are reported without leaving the page', async () => {
    const navigate = vi.fn();
    renderWithApp(
      <SignInPanel
        next="/"
        testSignIn
        navigate={navigate}
        fetchImpl={fetchReturning(reply(401))}
      />,
    );
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@test.local' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(messages.auth.signin.invalidCredentials)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('AuthErrorView', () => {
  it('[UI-036] renders the text for the code and a way back to sign-in', () => {
    renderWithApp(<AuthErrorView code="role_assignment_required" />);
    expect(screen.getByText(messages.auth.error.title)).toBeTruthy();
    expect(screen.getByText(messages.auth.error.role_assignment_required)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to sign-in' }).getAttribute('href')).toBe(
      '/signin',
    );
  });
});
