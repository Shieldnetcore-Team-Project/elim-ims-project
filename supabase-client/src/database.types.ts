// Hand-authored, covers only the `users` table (what the auth demo touches)
// so `supabase.from('users')` typechecks correctly against the real column
// names in supabase/migrations/20260101000003_people_and_access.sql +
// 20260803120000_auth_link_users.sql + 20260803120100_actor_columns.sql.
// Regenerate the full file for real once a local/remote Supabase project is
// reachable: `npm run gen-types -w supabase-client` (see package.json).
interface UsersRow {
  id: string;
  code: string;
  employee_id: string | null;
  full_name: string;
  email: string | null;
  role_id: string | null;
  status: string;
  last_active_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  auth_user_id: string | null;
  created_by: string | null;
  updated_by: string | null;
}

export interface Database {
  public: {
    Tables: {
      users: {
        Row: UsersRow;
        Insert: Partial<UsersRow>;
        Update: Partial<UsersRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
