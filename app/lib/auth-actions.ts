'use server';

import { redirect } from 'next/navigation';
import { supabaseConfigured } from './supabase/env';
import { createSupabaseServerClient } from './supabase/server';

export async function signInAction(form: FormData) {
  if (!supabaseConfigured()) redirect('/');
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect('/');
}

export async function signOutAction() {
  if (supabaseConfigured()) {
    const supabase = createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect('/login');
}
