import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export function LogoutPage() {
  useEffect(() => {
    void supabase.auth.signOut();
  }, []);

  return <Navigate to="/login" replace />;
}
