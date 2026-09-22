export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          factory_id: string | null
          id: string
          ip_address: string | null
          new_value: Json | null
          old_value: Json | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          factory_id?: string | null
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          old_value?: Json | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          factory_id?: string | null
          id?: string
          ip_address?: string | null
          new_value?: Json | null
          old_value?: Json | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_transactions: {
        Row: {
          amount: number
          category: string
          created_at: string
          description: string | null
          factory_id: string
          id: string
          payer_payee: string | null
          payment_method: Database["public"]["Enums"]["payment_method"]
          recorded_by: string | null
          recorded_by_name: string
          related_reference: string | null
          transaction_date: string
          transaction_number: string
          transaction_type: string
        }
        Insert: {
          amount: number
          category: string
          created_at?: string
          description?: string | null
          factory_id: string
          id?: string
          payer_payee?: string | null
          payment_method?: Database["public"]["Enums"]["payment_method"]
          recorded_by?: string | null
          recorded_by_name: string
          related_reference?: string | null
          transaction_date?: string
          transaction_number: string
          transaction_type: string
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string
          description?: string | null
          factory_id?: string
          id?: string
          payer_payee?: string | null
          payment_method?: Database["public"]["Enums"]["payment_method"]
          recorded_by?: string | null
          recorded_by_name?: string
          related_reference?: string | null
          transaction_date?: string
          transaction_number?: string
          transaction_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_transactions_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      costing_price_options: {
        Row: {
          created_at: string
          id: string
          margin: number
          margin_percent: number
          proposed_price: number
          sheet_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          margin: number
          margin_percent: number
          proposed_price: number
          sheet_id: string
        }
        Update: {
          created_at?: string
          id?: string
          margin?: number
          margin_percent?: number
          proposed_price?: number
          sheet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "costing_price_options_sheet_id_fkey"
            columns: ["sheet_id"]
            isOneToOne: false
            referencedRelation: "costing_sheets"
            referencedColumns: ["id"]
          },
        ]
      }
      costing_sheet_items: {
        Row: {
          id: string
          line_total: number
          material_id: string
          quantity: number
          role: string | null
          sheet_id: string
          unit_cost: number
        }
        Insert: {
          id?: string
          line_total: number
          material_id: string
          quantity: number
          role?: string | null
          sheet_id: string
          unit_cost: number
        }
        Update: {
          id?: string
          line_total?: number
          material_id?: string
          quantity?: number
          role?: string | null
          sheet_id?: string
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "costing_sheet_items_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "costing_sheet_items_sheet_id_fkey"
            columns: ["sheet_id"]
            isOneToOne: false
            referencedRelation: "costing_sheets"
            referencedColumns: ["id"]
          },
        ]
      }
      costing_sheets: {
        Row: {
          apply_to_product: boolean
          approved_at: string | null
          approved_by: string | null
          cost_per_pack: number
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          is_applied: boolean | null
          labor_cost: number
          material_cost: number
          notes: string | null
          overhead_cost: number
          overhead_percent: number | null
          pack_cost: number
          pack_quantity: number
          product_id: string
          reject_reason: string | null
          sheet_number: string
          sheet_type: string | null
          status: string
          total_cost: number
          unit_cost: number
          yield_quantity: number
        }
        Insert: {
          apply_to_product?: boolean
          approved_at?: string | null
          approved_by?: string | null
          cost_per_pack?: number
          created_at?: string
          created_by?: string | null
          factory_id: string
          id?: string
          is_applied?: boolean | null
          labor_cost?: number
          material_cost?: number
          notes?: string | null
          overhead_cost?: number
          overhead_percent?: number | null
          pack_cost?: number
          pack_quantity?: number
          product_id: string
          reject_reason?: string | null
          sheet_number: string
          sheet_type?: string | null
          status?: string
          total_cost?: number
          unit_cost?: number
          yield_quantity: number
        }
        Update: {
          apply_to_product?: boolean
          approved_at?: string | null
          approved_by?: string | null
          cost_per_pack?: number
          created_at?: string
          created_by?: string | null
          factory_id?: string
          id?: string
          is_applied?: boolean | null
          labor_cost?: number
          material_cost?: number
          notes?: string | null
          overhead_cost?: number
          overhead_percent?: number | null
          pack_cost?: number
          pack_quantity?: number
          product_id?: string
          reject_reason?: string | null
          sheet_number?: string
          sheet_type?: string | null
          status?: string
          total_cost?: number
          unit_cost?: number
          yield_quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "costing_sheets_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "costing_sheets_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          created_at: string
          credit_balance: number
          email: string | null
          factory_id: string
          id: string
          name: string
          outstanding_balance: number
          phone: string | null
          registered: boolean
          total_purchases: number
          total_transactions: number
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          credit_balance?: number
          email?: string | null
          factory_id: string
          id?: string
          name: string
          outstanding_balance?: number
          phone?: string | null
          registered?: boolean
          total_purchases?: number
          total_transactions?: number
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          credit_balance?: number
          email?: string | null
          factory_id?: string
          id?: string
          name?: string
          outstanding_balance?: number
          phone?: string | null
          registered?: boolean
          total_purchases?: number
          total_transactions?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      damage_records: {
        Row: {
          approved_by: string | null
          created_at: string
          factory_id: string
          id: string
          material_id: string | null
          product_id: string | null
          quantity: number
          reason: string | null
          reference_number: string
          reported_by: string
          source_reference: string | null
          source_type: string
          status: string
          unit: string | null
          unit_cost: number | null
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          created_at?: string
          factory_id: string
          id?: string
          material_id?: string | null
          product_id?: string | null
          quantity: number
          reason?: string | null
          reference_number: string
          reported_by: string
          source_reference?: string | null
          source_type: string
          status?: string
          unit?: string | null
          unit_cost?: number | null
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          created_at?: string
          factory_id?: string
          id?: string
          material_id?: string | null
          product_id?: string | null
          quantity?: number
          reason?: string | null
          reference_number?: string
          reported_by?: string
          source_reference?: string | null
          source_type?: string
          status?: string
          unit?: string | null
          unit_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "damage_records_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "damage_records_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "damage_records_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      debt_payments: {
        Row: {
          amount: number
          created_at: string
          debt_id: string
          id: string
          payment_date: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          received_by: string | null
          remarks: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          debt_id: string
          id?: string
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          received_by?: string | null
          remarks?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          debt_id?: string
          id?: string
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          received_by?: string | null
          remarks?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "debt_payments_debt_id_fkey"
            columns: ["debt_id"]
            isOneToOne: false
            referencedRelation: "debts"
            referencedColumns: ["id"]
          },
        ]
      }
      debts: {
        Row: {
          amount_paid: number
          created_at: string
          customer_id: string | null
          factory_id: string
          id: string
          outstanding: number
          sale_id: string | null
          sales_rep_id: string | null
          status: Database["public"]["Enums"]["debt_status"]
          total_amount: number
          updated_at: string
          writeoff_amount: number | null
          writeoff_reason: string | null
          writeoff_reject_reason: string | null
          writeoff_requested_at: string | null
          writeoff_requested_by: string | null
          writeoff_reviewed_at: string | null
          writeoff_reviewed_by: string | null
          writeoff_status: string | null
        }
        Insert: {
          amount_paid?: number
          created_at?: string
          customer_id?: string | null
          factory_id: string
          id?: string
          outstanding?: number
          sale_id?: string | null
          sales_rep_id?: string | null
          status?: Database["public"]["Enums"]["debt_status"]
          total_amount: number
          updated_at?: string
          writeoff_amount?: number | null
          writeoff_reason?: string | null
          writeoff_reject_reason?: string | null
          writeoff_requested_at?: string | null
          writeoff_requested_by?: string | null
          writeoff_reviewed_at?: string | null
          writeoff_reviewed_by?: string | null
          writeoff_status?: string | null
        }
        Update: {
          amount_paid?: number
          created_at?: string
          customer_id?: string | null
          factory_id?: string
          id?: string
          outstanding?: number
          sale_id?: string | null
          sales_rep_id?: string | null
          status?: Database["public"]["Enums"]["debt_status"]
          total_amount?: number
          updated_at?: string
          writeoff_amount?: number | null
          writeoff_reason?: string | null
          writeoff_reject_reason?: string | null
          writeoff_requested_at?: string | null
          writeoff_requested_by?: string | null
          writeoff_reviewed_at?: string | null
          writeoff_reviewed_by?: string | null
          writeoff_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "debts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "debts_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "debts_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "debts_sales_rep_id_fkey"
            columns: ["sales_rep_id"]
            isOneToOne: false
            referencedRelation: "sales_reps"
            referencedColumns: ["id"]
          },
        ]
      }
      delete_requests: {
        Row: {
          entity_id: string
          entity_label: string
          factory_id: string | null
          id: string
          module: string
          payload: Json | null
          reason: string
          requested_at: string
          requested_by: string
          review_reason: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          table_name: string
        }
        Insert: {
          entity_id: string
          entity_label: string
          factory_id?: string | null
          id?: string
          module: string
          payload?: Json | null
          reason: string
          requested_at?: string
          requested_by: string
          review_reason?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          table_name: string
        }
        Update: {
          entity_id?: string
          entity_label?: string
          factory_id?: string | null
          id?: string
          module?: string
          payload?: Json | null
          reason?: string
          requested_at?: string
          requested_by?: string
          review_reason?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "delete_requests_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      deliveries: {
        Row: {
          created_at: string
          created_by: string | null
          delivered_at: string | null
          delivery_number: string
          departed_at: string | null
          destination: string | null
          driver_id: string | null
          factory_id: string
          id: string
          notes: string | null
          route_id: string | null
          sale_id: string | null
          scheduled_date: string
          status: string
          vehicle_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          delivered_at?: string | null
          delivery_number: string
          departed_at?: string | null
          destination?: string | null
          driver_id?: string | null
          factory_id: string
          id?: string
          notes?: string | null
          route_id?: string | null
          sale_id?: string | null
          scheduled_date?: string
          status?: string
          vehicle_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          delivered_at?: string | null
          delivery_number?: string
          departed_at?: string | null
          destination?: string | null
          driver_id?: string | null
          factory_id?: string
          id?: string
          notes?: string | null
          route_id?: string | null
          sale_id?: string | null
          scheduled_date?: string
          status?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "delivery_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_routes: {
        Row: {
          created_at: string
          description: string | null
          factory_id: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          factory_id: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          description?: string | null
          factory_id?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_routes_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          created_at: string
          factory_id: string
          full_name: string
          id: string
          license_number: string | null
          phone: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          factory_id: string
          full_name: string
          id?: string
          license_number?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          factory_id?: string
          full_name?: string
          id?: string
          license_number?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "drivers_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_documents: {
        Row: {
          created_at: string
          employee_id: string
          factory_id: string
          file_name: string
          file_path: string
          id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          employee_id: string
          factory_id: string
          file_name: string
          file_path: string
          id?: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          employee_id?: string
          factory_id?: string
          file_name?: string
          file_path?: string
          id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          account_number: string | null
          bank_name: string | null
          basic_salary: number
          created_at: string
          department: string | null
          dob: string | null
          email: string | null
          emergency_contact: string | null
          employee_code: string | null
          employment_date: string | null
          factory_id: string
          full_name: string
          gender: string | null
          housing_allowance: number | null
          id: string
          meal_allowance: number | null
          medical_allowance: number | null
          other_allowances: number | null
          phone: string | null
          photo_url: string | null
          position: string | null
          status: string | null
          transport_allowance: number | null
          updated_at: string
        }
        Insert: {
          account_number?: string | null
          bank_name?: string | null
          basic_salary?: number
          created_at?: string
          department?: string | null
          dob?: string | null
          email?: string | null
          emergency_contact?: string | null
          employee_code?: string | null
          employment_date?: string | null
          factory_id: string
          full_name: string
          gender?: string | null
          housing_allowance?: number | null
          id?: string
          meal_allowance?: number | null
          medical_allowance?: number | null
          other_allowances?: number | null
          phone?: string | null
          photo_url?: string | null
          position?: string | null
          status?: string | null
          transport_allowance?: number | null
          updated_at?: string
        }
        Update: {
          account_number?: string | null
          bank_name?: string | null
          basic_salary?: number
          created_at?: string
          department?: string | null
          dob?: string | null
          email?: string | null
          emergency_contact?: string | null
          employee_code?: string | null
          employment_date?: string | null
          factory_id?: string
          full_name?: string
          gender?: string | null
          housing_allowance?: number | null
          id?: string
          meal_allowance?: number | null
          medical_allowance?: number | null
          other_allowances?: number | null
          phone?: string | null
          photo_url?: string | null
          position?: string | null
          status?: string | null
          transport_allowance?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          created_at: string
          factory_id: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          factory_id: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          factory_id?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          attachment_url: string | null
          category_id: string | null
          created_at: string
          description: string | null
          expense_date: string
          factory_id: string
          id: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          receipt_number: string | null
          recorded_by: string | null
          remarks: string | null
          requested_by_name: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_by: string | null
          vendor: string | null
        }
        Insert: {
          amount: number
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          attachment_url?: string | null
          category_id?: string | null
          created_at?: string
          description?: string | null
          expense_date?: string
          factory_id: string
          id?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          receipt_number?: string | null
          recorded_by?: string | null
          remarks?: string | null
          requested_by_name?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_by?: string | null
          vendor?: string | null
        }
        Update: {
          amount?: number
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          attachment_url?: string | null
          category_id?: string | null
          created_at?: string
          description?: string | null
          expense_date?: string
          factory_id?: string
          id?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          receipt_number?: string | null
          recorded_by?: string | null
          remarks?: string | null
          requested_by_name?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_by?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      factories: {
        Row: {
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      goods_receipts: {
        Row: {
          accepted_quantity: number | null
          confirmed_at: string | null
          confirmed_by: string | null
          damaged_quantity: number
          delivery_reference: string | null
          factory_id: string
          id: string
          material_id: string
          purchase_order_id: string | null
          purchase_request_id: string | null
          quantity: number
          receipt_number: string
          reject_reason: string | null
          remarks: string | null
          status: string
          submitted_at: string
          submitted_by: string
          supplier_id: string | null
          unit: string | null
          unit_cost: number | null
        }
        Insert: {
          accepted_quantity?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          damaged_quantity?: number
          delivery_reference?: string | null
          factory_id: string
          id?: string
          material_id: string
          purchase_order_id?: string | null
          purchase_request_id?: string | null
          quantity: number
          receipt_number: string
          reject_reason?: string | null
          remarks?: string | null
          status?: string
          submitted_at?: string
          submitted_by: string
          supplier_id?: string | null
          unit?: string | null
          unit_cost?: number | null
        }
        Update: {
          accepted_quantity?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          damaged_quantity?: number
          delivery_reference?: string | null
          factory_id?: string
          id?: string
          material_id?: string
          purchase_order_id?: string | null
          purchase_request_id?: string | null
          quantity?: number
          receipt_number?: string
          reject_reason?: string | null
          remarks?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string
          supplier_id?: string | null
          unit?: string | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "goods_receipts_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipts_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipts_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipts_purchase_request_id_fkey"
            columns: ["purchase_request_id"]
            isOneToOne: false
            referencedRelation: "production_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipts_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_movements: {
        Row: {
          created_at: string
          factory_id: string
          id: string
          movement_type: Database["public"]["Enums"]["movement_type"]
          product_id: string
          quantity: number
          quantity_after: number | null
          quantity_before: number | null
          reason: string | null
          reference: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          factory_id: string
          id?: string
          movement_type: Database["public"]["Enums"]["movement_type"]
          product_id: string
          quantity: number
          quantity_after?: number | null
          quantity_before?: number | null
          reason?: string | null
          reference?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          factory_id?: string
          id?: string
          movement_type?: Database["public"]["Enums"]["movement_type"]
          product_id?: string
          quantity?: number
          quantity_after?: number | null
          quantity_before?: number | null
          reason?: string | null
          reference?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      material_categories: {
        Row: {
          created_at: string
          description: string | null
          factory_id: string
          id: string
          name: string
          product_line: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          factory_id: string
          id?: string
          name: string
          product_line?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          factory_id?: string
          id?: string
          name?: string
          product_line?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_categories_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          factory_id: string | null
          id: string
          read: boolean
          title: string
          user_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          factory_id?: string | null
          id?: string
          read?: boolean
          title: string
          user_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          factory_id?: string | null
          id?: string
          read?: boolean
          title?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      payments_received: {
        Row: {
          amount: number
          created_at: string
          customer_id: string | null
          factory_id: string
          id: string
          payment_date: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          receipt_number: string
          received_by: string | null
          remarks: string | null
          review_note: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          sale_id: string | null
          status: string
        }
        Insert: {
          amount: number
          created_at?: string
          customer_id?: string | null
          factory_id: string
          id?: string
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          receipt_number: string
          received_by?: string | null
          remarks?: string | null
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_id?: string | null
          status?: string
        }
        Update: {
          amount?: number
          created_at?: string
          customer_id?: string | null
          factory_id?: string
          id?: string
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          receipt_number?: string
          received_by?: string | null
          remarks?: string | null
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_received_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_received_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_received_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll: {
        Row: {
          account_number: string | null
          advance: number
          bank_name: string | null
          basic_salary: number
          created_at: string
          employee_id: string
          factory_id: string
          gross_salary: number
          housing_allowance: number
          id: string
          loans: number
          meal_allowance: number
          medical_allowance: number
          net_salary: number
          other_allowances: number
          other_deductions: number
          overtime: number
          paye: number
          payment_date: string | null
          payment_method: Database["public"]["Enums"]["payment_method"] | null
          pension: number
          period_month: number
          period_year: number
          review_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string
          submitted_by: string | null
          transport_allowance: number
        }
        Insert: {
          account_number?: string | null
          advance?: number
          bank_name?: string | null
          basic_salary?: number
          created_at?: string
          employee_id: string
          factory_id: string
          gross_salary?: number
          housing_allowance?: number
          id?: string
          loans?: number
          meal_allowance?: number
          medical_allowance?: number
          net_salary?: number
          other_allowances?: number
          other_deductions?: number
          overtime?: number
          paye?: number
          payment_date?: string | null
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          pension?: number
          period_month: number
          period_year: number
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          transport_allowance?: number
        }
        Update: {
          account_number?: string | null
          advance?: number
          bank_name?: string | null
          basic_salary?: number
          created_at?: string
          employee_id?: string
          factory_id?: string
          gross_salary?: number
          housing_allowance?: number
          id?: string
          loans?: number
          meal_allowance?: number
          medical_allowance?: number
          net_salary?: number
          other_allowances?: number
          other_deductions?: number
          overtime?: number
          paye?: number
          payment_date?: string | null
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          pension?: number
          period_month?: number
          period_year?: number
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          transport_allowance?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      permission_overrides: {
        Row: {
          action: string
          granted: boolean
          granted_at: string
          granted_by: string | null
          module: string
          user_id: string
        }
        Insert: {
          action: string
          granted: boolean
          granted_at?: string
          granted_by?: string | null
          module: string
          user_id: string
        }
        Update: {
          action?: string
          granted?: boolean
          granted_at?: string
          granted_by?: string | null
          module?: string
          user_id?: string
        }
        Relationships: []
      }
      product_categories: {
        Row: {
          created_at: string
          description: string | null
          factory_id: string
          id: string
          name: string
          product_line: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          factory_id: string
          id?: string
          name: string
          product_line?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          factory_id?: string
          id?: string
          name?: string
          product_line?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_categories_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      product_price_history: {
        Row: {
          approved_by: string | null
          created_at: string
          created_by: string | null
          effective_date: string
          id: string
          previous_price: number | null
          price: number
          product_id: string
        }
        Insert: {
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          previous_price?: number | null
          price: number
          product_id: string
        }
        Update: {
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          previous_price?: number | null
          price?: number
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_price_history_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_units: {
        Row: {
          active: boolean
          base_unit: string
          conversion_factor: number
          created_at: string
          id: string
          packaging_unit: string
          product_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          base_unit: string
          conversion_factor: number
          created_at?: string
          id?: string
          packaging_unit: string
          product_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          base_unit?: string
          conversion_factor?: number
          created_at?: string
          id?: string
          packaging_unit?: string
          product_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_units_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      production: {
        Row: {
          accepted_quantity: number | null
          actual_quantity_received: number | null
          batch_number: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          created_by: string | null
          damaged_quantity: number
          department: string | null
          factory_id: string
          id: string
          packaging_quantity: number | null
          packaging_unit: string | null
          product_id: string
          production_cost: number | null
          production_date: string
          production_number: string
          production_request_id: string | null
          production_scope: string | null
          production_type_id: string | null
          quantity_produced: number
          reject_reason: string | null
          rejected_quantity: number
          remarks: string | null
          status: string
          supervisor: string | null
          unit: string | null
        }
        Insert: {
          accepted_quantity?: number | null
          actual_quantity_received?: number | null
          batch_number?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string | null
          damaged_quantity?: number
          department?: string | null
          factory_id: string
          id?: string
          packaging_quantity?: number | null
          packaging_unit?: string | null
          product_id: string
          production_cost?: number | null
          production_date?: string
          production_number: string
          production_request_id?: string | null
          production_scope?: string | null
          production_type_id?: string | null
          quantity_produced: number
          reject_reason?: string | null
          rejected_quantity?: number
          remarks?: string | null
          status?: string
          supervisor?: string | null
          unit?: string | null
        }
        Update: {
          accepted_quantity?: number | null
          actual_quantity_received?: number | null
          batch_number?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string | null
          damaged_quantity?: number
          department?: string | null
          factory_id?: string
          id?: string
          packaging_quantity?: number | null
          packaging_unit?: string | null
          product_id?: string
          production_cost?: number | null
          production_date?: string
          production_number?: string
          production_request_id?: string | null
          production_scope?: string | null
          production_type_id?: string | null
          quantity_produced?: number
          reject_reason?: string | null
          rejected_quantity?: number
          remarks?: string | null
          status?: string
          supervisor?: string | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "production_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_production_request_id_fkey"
            columns: ["production_request_id"]
            isOneToOne: false
            referencedRelation: "production_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_production_type_id_fkey"
            columns: ["production_type_id"]
            isOneToOne: false
            referencedRelation: "production_types"
            referencedColumns: ["id"]
          },
        ]
      }
      production_request_items: {
        Row: {
          created_at: string
          id: string
          material_id: string
          quantity_issued: number
          quantity_requested: number
          request_id: string
          unit: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          material_id: string
          quantity_issued?: number
          quantity_requested: number
          request_id: string
          unit?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          material_id?: string
          quantity_issued?: number
          quantity_requested?: number
          request_id?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "production_request_items_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_request_items_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "production_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      production_requests: {
        Row: {
          approval_date: string | null
          approval_status: string
          approved_by_name: string | null
          auto_generated: boolean
          created_at: string
          department: string | null
          factory_id: string
          id: string
          issued_at: string | null
          issued_by_name: string | null
          material_id: string | null
          materials_issued: boolean
          po_number: string | null
          product_id: string | null
          production_id: string | null
          production_status: string
          quantity_requested: number
          remarks: string | null
          request_date: string
          request_number: string
          request_type: string
          requested_by: string | null
          requested_by_name: string
          supplier_id: string | null
          unit: string | null
        }
        Insert: {
          approval_date?: string | null
          approval_status?: string
          approved_by_name?: string | null
          auto_generated?: boolean
          created_at?: string
          department?: string | null
          factory_id: string
          id?: string
          issued_at?: string | null
          issued_by_name?: string | null
          material_id?: string | null
          materials_issued?: boolean
          po_number?: string | null
          product_id?: string | null
          production_id?: string | null
          production_status?: string
          quantity_requested: number
          remarks?: string | null
          request_date?: string
          request_number: string
          request_type?: string
          requested_by?: string | null
          requested_by_name: string
          supplier_id?: string | null
          unit?: string | null
        }
        Update: {
          approval_date?: string | null
          approval_status?: string
          approved_by_name?: string | null
          auto_generated?: boolean
          created_at?: string
          department?: string | null
          factory_id?: string
          id?: string
          issued_at?: string | null
          issued_by_name?: string | null
          material_id?: string | null
          materials_issued?: boolean
          po_number?: string | null
          product_id?: string | null
          production_id?: string | null
          production_status?: string
          quantity_requested?: number
          remarks?: string | null
          request_date?: string
          request_number?: string
          request_type?: string
          requested_by?: string | null
          requested_by_name?: string
          supplier_id?: string | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "production_requests_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_requests_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_requests_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_requests_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "production"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_requests_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      production_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          created_by: string | null
          department: string | null
          id: string
          name: string
          production_scope: string
          unit_of_measure: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          created_by?: string | null
          department?: string | null
          id?: string
          name: string
          production_scope?: string
          unit_of_measure?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          created_by?: string | null
          department?: string | null
          id?: string
          name?: string
          production_scope?: string
          unit_of_measure?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          active: boolean
          barcode: string | null
          category_id: string | null
          cost_price: number
          created_at: string
          current_stock: number
          factory_id: string
          id: string
          name: string
          product_type: string
          reorder_level: number | null
          sku: string | null
          unit: string
          unit_price: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          barcode?: string | null
          category_id?: string | null
          cost_price?: number
          created_at?: string
          current_stock?: number
          factory_id: string
          id?: string
          name: string
          product_type?: string
          reorder_level?: number | null
          sku?: string | null
          unit?: string
          unit_price?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          barcode?: string | null
          category_id?: string | null
          cost_price?: number
          created_at?: string
          current_stock?: number
          factory_id?: string
          id?: string
          name?: string
          product_type?: string
          reorder_level?: number | null
          sku?: string | null
          unit?: string
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "product_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active_factory_id: string | null
          approved_at: string | null
          approved_by: string | null
          avatar_url: string | null
          created_at: string
          created_by: string | null
          department: string | null
          email: string | null
          full_name: string | null
          id: string
          phone: string | null
          production_scope: string
          rejected_at: string | null
          rejected_by: string | null
          rejected_reason: string | null
          requested_factory_id: string | null
          role_requested: string | null
          status: string
          updated_at: string
          username: string | null
        }
        Insert: {
          active_factory_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          department?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          production_scope?: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_reason?: string | null
          requested_factory_id?: string | null
          role_requested?: string | null
          status?: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          active_factory_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          department?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          production_scope?: string
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_reason?: string | null
          requested_factory_id?: string | null
          role_requested?: string | null
          status?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_active_factory_id_fkey"
            columns: ["active_factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_requested_factory_id_fkey"
            columns: ["requested_factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_role_requested_fkey"
            columns: ["role_requested"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["slug"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          approved_by_name: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          created_at: string
          expected_delivery_date: string | null
          factory_id: string
          id: string
          issued_at: string
          issued_by: string | null
          issued_by_name: string
          material_id: string
          notes: string | null
          po_number: string
          purchase_request_id: string
          quantity_ordered: number
          quantity_received: number
          status: string
          supplier_id: string | null
          total_amount: number | null
          unit: string | null
          unit_cost: number | null
        }
        Insert: {
          approved_by_name?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          created_at?: string
          expected_delivery_date?: string | null
          factory_id: string
          id?: string
          issued_at?: string
          issued_by?: string | null
          issued_by_name: string
          material_id: string
          notes?: string | null
          po_number: string
          purchase_request_id: string
          quantity_ordered: number
          quantity_received?: number
          status?: string
          supplier_id?: string | null
          total_amount?: number | null
          unit?: string | null
          unit_cost?: number | null
        }
        Update: {
          approved_by_name?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          created_at?: string
          expected_delivery_date?: string | null
          factory_id?: string
          id?: string
          issued_at?: string
          issued_by?: string | null
          issued_by_name?: string
          material_id?: string
          notes?: string | null
          po_number?: string
          purchase_request_id?: string
          quantity_ordered?: number
          quantity_received?: number
          status?: string
          supplier_id?: string | null
          total_amount?: number | null
          unit?: string | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_purchase_request_id_fkey"
            columns: ["purchase_request_id"]
            isOneToOne: true
            referencedRelation: "production_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_material_cost_history: {
        Row: {
          cost: number
          created_at: string
          created_by: string | null
          effective_date: string
          id: string
          material_id: string
          previous_cost: number | null
        }
        Insert: {
          cost: number
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          material_id: string
          previous_cost?: number | null
        }
        Update: {
          cost?: number
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          material_id?: string
          previous_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_material_cost_history_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_material_movements: {
        Row: {
          created_at: string
          factory_id: string
          id: string
          material_id: string
          movement_type: Database["public"]["Enums"]["movement_type"]
          quantity: number
          quantity_after: number | null
          quantity_before: number | null
          reason: string | null
          reference: string | null
          unit_cost: number | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          factory_id: string
          id?: string
          material_id: string
          movement_type: Database["public"]["Enums"]["movement_type"]
          quantity: number
          quantity_after?: number | null
          quantity_before?: number | null
          reason?: string | null
          reference?: string | null
          unit_cost?: number | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          factory_id?: string
          id?: string
          material_id?: string
          movement_type?: Database["public"]["Enums"]["movement_type"]
          quantity?: number
          quantity_after?: number | null
          quantity_before?: number | null
          reason?: string | null
          reference?: string | null
          unit_cost?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_material_movements_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_material_movements_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_materials: {
        Row: {
          active: boolean
          approval_status: string
          category: string | null
          category_id: string | null
          created_at: string
          created_by: string | null
          current_stock: number
          current_value: number
          factory_id: string
          id: string
          minimum_stock: number | null
          name: string
          opening_stock: number
          remarks: string | null
          reorder_level: number | null
          supplier_id: string | null
          unit: string
          unit_cost: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          approval_status?: string
          category?: string | null
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          current_stock?: number
          current_value?: number
          factory_id: string
          id?: string
          minimum_stock?: number | null
          name: string
          opening_stock?: number
          remarks?: string | null
          reorder_level?: number | null
          supplier_id?: string | null
          unit?: string
          unit_cost?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          approval_status?: string
          category?: string | null
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          current_stock?: number
          current_value?: number
          factory_id?: string
          id?: string
          minimum_stock?: number | null
          name?: string
          opening_stock?: number
          remarks?: string | null
          reorder_level?: number | null
          supplier_id?: string | null
          unit?: string
          unit_cost?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_materials_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "material_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_materials_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_materials_supplier_fk"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_remittances: {
        Row: {
          amount: number
          created_at: string
          factory_id: string
          id: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          received_by: string | null
          remarks: string | null
          remittance_date: string
          remittance_number: string
          sales_rep_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          factory_id: string
          id?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          received_by?: string | null
          remarks?: string | null
          remittance_date?: string
          remittance_number: string
          sales_rep_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          factory_id?: string
          id?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          received_by?: string | null
          remarks?: string | null
          remittance_date?: string
          remittance_number?: string
          sales_rep_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rep_remittances_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_remittances_sales_rep_id_fkey"
            columns: ["sales_rep_id"]
            isOneToOne: false
            referencedRelation: "sales_reps"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_return_items: {
        Row: {
          accepted_quantity: number | null
          charge_rep: boolean
          damaged_quantity: number
          id: string
          product_id: string
          quantity_returned: number
          rejected_quantity: number
          rep_return_id: string
          unit_price: number
        }
        Insert: {
          accepted_quantity?: number | null
          charge_rep?: boolean
          damaged_quantity?: number
          id?: string
          product_id: string
          quantity_returned: number
          rejected_quantity?: number
          rep_return_id: string
          unit_price?: number
        }
        Update: {
          accepted_quantity?: number | null
          charge_rep?: boolean
          damaged_quantity?: number
          id?: string
          product_id?: string
          quantity_returned?: number
          rejected_quantity?: number
          rep_return_id?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "rep_return_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_return_items_rep_return_id_fkey"
            columns: ["rep_return_id"]
            isOneToOne: false
            referencedRelation: "rep_returns"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_returns: {
        Row: {
          created_at: string
          factory_id: string
          id: string
          inspected_at: string | null
          inspected_by: string | null
          notes: string | null
          received_at: string
          received_by: string
          return_date: string
          return_number: string
          sales_rep_id: string
          status: string
        }
        Insert: {
          created_at?: string
          factory_id: string
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          notes?: string | null
          received_at?: string
          received_by: string
          return_date?: string
          return_number: string
          sales_rep_id: string
          status?: string
        }
        Update: {
          created_at?: string
          factory_id?: string
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          notes?: string | null
          received_at?: string
          received_by?: string
          return_date?: string
          return_number?: string
          sales_rep_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "rep_returns_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_returns_sales_rep_id_fkey"
            columns: ["sales_rep_id"]
            isOneToOne: false
            referencedRelation: "sales_reps"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_stock: {
        Row: {
          factory_id: string
          product_id: string
          quantity: number
          sales_rep_id: string
          updated_at: string
        }
        Insert: {
          factory_id: string
          product_id: string
          quantity?: number
          sales_rep_id: string
          updated_at?: string
        }
        Update: {
          factory_id?: string
          product_id?: string
          quantity?: number
          sales_rep_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rep_stock_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_stock_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_stock_sales_rep_id_fkey"
            columns: ["sales_rep_id"]
            isOneToOne: false
            referencedRelation: "sales_reps"
            referencedColumns: ["id"]
          },
        ]
      }
      rep_stock_movements: {
        Row: {
          created_at: string
          factory_id: string
          id: string
          movement_type: string
          product_id: string
          quantity: number
          quantity_after: number | null
          quantity_before: number | null
          reason: string | null
          reference: string | null
          sales_rep_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          factory_id: string
          id?: string
          movement_type: string
          product_id: string
          quantity: number
          quantity_after?: number | null
          quantity_before?: number | null
          reason?: string | null
          reference?: string | null
          sales_rep_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          factory_id?: string
          id?: string
          movement_type?: string
          product_id?: string
          quantity?: number
          quantity_after?: number | null
          quantity_before?: number | null
          reason?: string | null
          reference?: string | null
          sales_rep_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rep_stock_movements_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_stock_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rep_stock_movements_sales_rep_id_fkey"
            columns: ["sales_rep_id"]
            isOneToOne: false
            referencedRelation: "sales_reps"
            referencedColumns: ["id"]
          },
        ]
      }
      role_grant_requests: {
        Row: {
          action: string
          factory_id: string | null
          id: string
          requested_at: string
          requested_by: string
          review_reason: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          role: string
          status: string
          target_user_id: string
        }
        Insert: {
          action?: string
          factory_id?: string | null
          id?: string
          requested_at?: string
          requested_by: string
          review_reason?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          role: string
          status?: string
          target_user_id: string
        }
        Update: {
          action?: string
          factory_id?: string | null
          id?: string
          requested_at?: string
          requested_by?: string
          review_reason?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          role?: string
          status?: string
          target_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_grant_requests_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          action: string
          module: string
          role: string
        }
        Insert: {
          action: string
          module: string
          role: string
        }
        Update: {
          action?: string
          module?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_role_fkey"
            columns: ["role"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["slug"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          is_system: boolean
          label: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          is_system?: boolean
          label: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          is_system?: boolean
          label?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      sale_items: {
        Row: {
          id: string
          line_total: number
          product_id: string
          quantity: number
          sale_id: string
          unit_price: number
        }
        Insert: {
          id?: string
          line_total: number
          product_id: string
          quantity: number
          sale_id: string
          unit_price: number
        }
        Update: {
          id?: string
          line_total?: number
          product_id?: string
          quantity?: number
          sale_id?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      sales: {
        Row: {
          amount_paid: number
          approved_at: string | null
          approved_by: string | null
          balance: number
          created_at: string
          created_by: string | null
          credit_applied: number
          customer_address: string | null
          customer_id: string | null
          customer_name: string | null
          customer_phone: string | null
          deleted_at: string | null
          discount: number
          factory_id: string
          grand_total: number
          id: string
          invoice_number: string
          is_pr: boolean
          payment_method: Database["public"]["Enums"]["payment_method"]
          pending_payments: Json | null
          rejected_reason: string | null
          remarks: string | null
          sale_date: string
          sales_person: string | null
          sales_rep_id: string | null
          status: string
          subtotal: number
          vat: number
        }
        Insert: {
          amount_paid?: number
          approved_at?: string | null
          approved_by?: string | null
          balance?: number
          created_at?: string
          created_by?: string | null
          credit_applied?: number
          customer_address?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          deleted_at?: string | null
          discount?: number
          factory_id: string
          grand_total?: number
          id?: string
          invoice_number: string
          is_pr?: boolean
          payment_method?: Database["public"]["Enums"]["payment_method"]
          pending_payments?: Json | null
          rejected_reason?: string | null
          remarks?: string | null
          sale_date?: string
          sales_person?: string | null
          sales_rep_id?: string | null
          status?: string
          subtotal?: number
          vat?: number
        }
        Update: {
          amount_paid?: number
          approved_at?: string | null
          approved_by?: string | null
          balance?: number
          created_at?: string
          created_by?: string | null
          credit_applied?: number
          customer_address?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          deleted_at?: string | null
          discount?: number
          factory_id?: string
          grand_total?: number
          id?: string
          invoice_number?: string
          is_pr?: boolean
          payment_method?: Database["public"]["Enums"]["payment_method"]
          pending_payments?: Json | null
          rejected_reason?: string | null
          remarks?: string | null
          sale_date?: string
          sales_person?: string | null
          sales_rep_id?: string | null
          status?: string
          subtotal?: number
          vat?: number
        }
        Relationships: [
          {
            foreignKeyName: "sales_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_sales_rep_id_fkey"
            columns: ["sales_rep_id"]
            isOneToOne: false
            referencedRelation: "sales_reps"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_reps: {
        Row: {
          code: string | null
          created_at: string
          employee_id: string | null
          factory_id: string
          full_name: string
          id: string
          phone: string | null
          remarks: string | null
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          code?: string | null
          created_at?: string
          employee_id?: string | null
          factory_id: string
          full_name: string
          id?: string
          phone?: string | null
          remarks?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          code?: string | null
          created_at?: string
          employee_id?: string | null
          factory_id?: string
          full_name?: string
          id?: string
          phone?: string | null
          remarks?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_reps_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_reps_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_returns: {
        Row: {
          accepted_quantity: number | null
          created_at: string
          customer_id: string | null
          damaged_quantity: number
          factory_id: string
          id: string
          inspected_at: string | null
          inspected_by: string | null
          notes: string | null
          product_id: string
          quantity_returned: number
          reason: string | null
          received_at: string
          received_by: string
          rejected_quantity: number
          return_number: string
          sale_id: string | null
          status: string
          unit: string | null
        }
        Insert: {
          accepted_quantity?: number | null
          created_at?: string
          customer_id?: string | null
          damaged_quantity?: number
          factory_id: string
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          notes?: string | null
          product_id: string
          quantity_returned: number
          reason?: string | null
          received_at?: string
          received_by: string
          rejected_quantity?: number
          return_number: string
          sale_id?: string | null
          status?: string
          unit?: string | null
        }
        Update: {
          accepted_quantity?: number | null
          created_at?: string
          customer_id?: string | null
          damaged_quantity?: number
          factory_id?: string
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          notes?: string | null
          product_id?: string
          quantity_returned?: number
          reason?: string | null
          received_at?: string
          received_by?: string
          rejected_quantity?: number
          return_number?: string
          sale_id?: string | null
          status?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_returns_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_returns_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_returns_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_returns_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          address: string | null
          company_name: string | null
          created_at: string
          currency: string | null
          email: string | null
          employee_prefix: string | null
          factory_id: string
          id: string
          invoice_prefix: string | null
          logo_url: string | null
          phone: string | null
          production_prefix: string | null
          receipt_prefix: string | null
          updated_at: string
          vat_rate: number | null
        }
        Insert: {
          address?: string | null
          company_name?: string | null
          created_at?: string
          currency?: string | null
          email?: string | null
          employee_prefix?: string | null
          factory_id: string
          id?: string
          invoice_prefix?: string | null
          logo_url?: string | null
          phone?: string | null
          production_prefix?: string | null
          receipt_prefix?: string | null
          updated_at?: string
          vat_rate?: number | null
        }
        Update: {
          address?: string | null
          company_name?: string | null
          created_at?: string
          currency?: string | null
          email?: string | null
          employee_prefix?: string | null
          factory_id?: string
          id?: string
          invoice_prefix?: string | null
          logo_url?: string | null
          phone?: string | null
          production_prefix?: string | null
          receipt_prefix?: string | null
          updated_at?: string
          vat_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "settings_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: true
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_deductions: {
        Row: {
          amount: number
          applied_payroll_id: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          employee_id: string
          factory_id: string
          id: string
          kind: string
          label: string
          period_month: number
          period_year: number
          reason: string | null
          reference_number: string
          reject_reason: string | null
          status: string
          submitted_at: string
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          applied_payroll_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          employee_id: string
          factory_id: string
          id?: string
          kind: string
          label: string
          period_month: number
          period_year: number
          reason?: string | null
          reference_number: string
          reject_reason?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          applied_payroll_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          employee_id?: string
          factory_id?: string
          id?: string
          kind?: string
          label?: string
          period_month?: number
          period_year?: number
          reason?: string | null
          reference_number?: string
          reject_reason?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_deductions_applied_payroll_id_fkey"
            columns: ["applied_payroll_id"]
            isOneToOne: false
            referencedRelation: "payroll"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_deductions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_deductions_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_loan_repayments: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          loan_id: string
          paid_at: string | null
          payroll_id: string | null
          period_month: number
          period_year: number
          status: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          factory_id: string
          id?: string
          loan_id: string
          paid_at?: string | null
          payroll_id?: string | null
          period_month: number
          period_year: number
          status?: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          factory_id?: string
          id?: string
          loan_id?: string
          paid_at?: string | null
          payroll_id?: string | null
          period_month?: number
          period_year?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_loan_repayments_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_loan_repayments_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "staff_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_loan_repayments_payroll_id_fkey"
            columns: ["payroll_id"]
            isOneToOne: false
            referencedRelation: "payroll"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_loans: {
        Row: {
          amount_repaid: number
          approved_at: string | null
          approved_by: string | null
          created_at: string
          disbursed_on: string
          employee_id: string
          factory_id: string
          id: string
          installment_amount: number | null
          installment_mode: string | null
          installment_months: number | null
          loan_number: string
          outstanding: number | null
          principal: number
          reason: string | null
          reject_reason: string | null
          remarks: string | null
          repayment_type: string
          status: string
          submitted_at: string
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          amount_repaid?: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          disbursed_on?: string
          employee_id: string
          factory_id: string
          id?: string
          installment_amount?: number | null
          installment_mode?: string | null
          installment_months?: number | null
          loan_number: string
          outstanding?: number | null
          principal: number
          reason?: string | null
          reject_reason?: string | null
          remarks?: string | null
          repayment_type: string
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          amount_repaid?: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          disbursed_on?: string
          employee_id?: string
          factory_id?: string
          id?: string
          installment_amount?: number | null
          installment_mode?: string | null
          installment_months?: number | null
          loan_number?: string
          outstanding?: number | null
          principal?: number
          reason?: string | null
          reject_reason?: string | null
          remarks?: string | null
          repayment_type?: string
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_loans_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_loans_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_adjustment_requests: {
        Row: {
          entity_type: string
          factory_id: string
          id: string
          material_id: string | null
          movement_type: string
          product_id: string | null
          quantity_delta: number
          reason: string | null
          reference_number: string
          review_reason: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string
          submitted_by: string
        }
        Insert: {
          entity_type: string
          factory_id: string
          id?: string
          material_id?: string | null
          movement_type?: string
          product_id?: string | null
          quantity_delta: number
          reason?: string | null
          reference_number: string
          review_reason?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by: string
        }
        Update: {
          entity_type?: string
          factory_id?: string
          id?: string
          material_id?: string | null
          movement_type?: string
          product_id?: string | null
          quantity_delta?: number
          reason?: string | null
          reference_number?: string
          review_reason?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_adjustment_requests_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustment_requests_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "raw_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustment_requests_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_dispatch_items: {
        Row: {
          dispatch_id: string
          id: string
          line_value: number
          product_id: string
          quantity: number
          unit_price: number
        }
        Insert: {
          dispatch_id: string
          id?: string
          line_value?: number
          product_id: string
          quantity: number
          unit_price?: number
        }
        Update: {
          dispatch_id?: string
          id?: string
          line_value?: number
          product_id?: string
          quantity?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "stock_dispatch_items_dispatch_id_fkey"
            columns: ["dispatch_id"]
            isOneToOne: false
            referencedRelation: "stock_dispatches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_dispatch_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_dispatches: {
        Row: {
          created_at: string
          created_by: string | null
          dispatch_date: string
          dispatch_number: string
          driver_id: string | null
          factory_id: string
          id: string
          notes: string | null
          reverse_reason: string | null
          reversed_at: string | null
          reversed_by: string | null
          route_id: string | null
          sales_rep_id: string
          status: string
          total_value: number
          vehicle_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dispatch_date?: string
          dispatch_number: string
          driver_id?: string | null
          factory_id: string
          id?: string
          notes?: string | null
          reverse_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          route_id?: string | null
          sales_rep_id: string
          status?: string
          total_value?: number
          vehicle_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dispatch_date?: string
          dispatch_number?: string
          driver_id?: string | null
          factory_id?: string
          id?: string
          notes?: string | null
          reverse_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          route_id?: string | null
          sales_rep_id?: string
          status?: string
          total_value?: number
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_dispatches_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_dispatches_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_dispatches_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "delivery_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_dispatches_sales_rep_id_fkey"
            columns: ["sales_rep_id"]
            isOneToOne: false
            referencedRelation: "sales_reps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_dispatches_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          bank_account_name: string | null
          bank_account_number: string | null
          bank_name: string | null
          category: string | null
          contact_person: string | null
          created_at: string
          created_by: string | null
          email: string | null
          factory_id: string
          id: string
          materials_supplied: string | null
          name: string
          notes: string | null
          outstanding_balance: number
          phone: string | null
          status: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          bank_account_name?: string | null
          bank_account_number?: string | null
          bank_name?: string | null
          category?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          factory_id: string
          id?: string
          materials_supplied?: string | null
          name: string
          notes?: string | null
          outstanding_balance?: number
          phone?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          bank_account_name?: string | null
          bank_account_number?: string | null
          bank_name?: string | null
          category?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          factory_id?: string
          id?: string
          materials_supplied?: string | null
          name?: string
          notes?: string | null
          outstanding_balance?: number
          phone?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      units_of_measure: {
        Row: {
          active: boolean
          code: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          factory_id: string | null
          id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          factory_id?: string | null
          id?: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          factory_id?: string | null
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_role_fkey"
            columns: ["role"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["slug"]
          },
        ]
      }
      vehicles: {
        Row: {
          brand: string | null
          capacity: string | null
          chassis_number: string | null
          color: string | null
          created_at: string
          engine_number: string | null
          factory_id: string
          id: string
          insurance_expiry_date: string | null
          make_model: string | null
          model: string | null
          plate_number: string
          registration_expiry_date: string | null
          status: string
          updated_at: string
          vehicle_type: string | null
          year: number | null
        }
        Insert: {
          brand?: string | null
          capacity?: string | null
          chassis_number?: string | null
          color?: string | null
          created_at?: string
          engine_number?: string | null
          factory_id: string
          id?: string
          insurance_expiry_date?: string | null
          make_model?: string | null
          model?: string | null
          plate_number: string
          registration_expiry_date?: string | null
          status?: string
          updated_at?: string
          vehicle_type?: string | null
          year?: number | null
        }
        Update: {
          brand?: string | null
          capacity?: string | null
          chassis_number?: string | null
          color?: string | null
          created_at?: string
          engine_number?: string | null
          factory_id?: string
          id?: string
          insurance_expiry_date?: string | null
          make_model?: string | null
          model?: string | null
          plate_number?: string
          registration_expiry_date?: string | null
          status?: string
          updated_at?: string
          vehicle_type?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_approval_history: {
        Row: {
          action: string
          actor: string
          comment: string | null
          created_at: string
          entity_id: string
          from_status: string | null
          id: string
          module: string
          to_status: string
          transaction_type: string
        }
        Insert: {
          action: string
          actor: string
          comment?: string | null
          created_at?: string
          entity_id: string
          from_status?: string | null
          id?: string
          module: string
          to_status: string
          transaction_type: string
        }
        Update: {
          action?: string
          actor?: string
          comment?: string | null
          created_at?: string
          entity_id?: string
          from_status?: string | null
          id?: string
          module?: string
          to_status?: string
          transaction_type?: string
        }
        Relationships: []
      }
      workflow_configs: {
        Row: {
          checker_label: string
          description: string | null
          final_status: string
          maker_label: string
          module: string
          required_approvals: number
          transaction_type: string
        }
        Insert: {
          checker_label: string
          description?: string | null
          final_status: string
          maker_label: string
          module: string
          required_approvals?: number
          transaction_type: string
        }
        Update: {
          checker_label?: string
          description?: string | null
          final_status?: string
          maker_label?: string
          module?: string
          required_approvals?: number
          transaction_type?: string
        }
        Relationships: []
      }
      workflow_transitions: {
        Row: {
          from_status: string
          to_status: string
        }
        Insert: {
          from_status: string
          to_status: string
        }
        Update: {
          from_status?: string
          to_status?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_provision_user: {
        Args: {
          p_department?: string
          p_factory_id?: string
          p_production_scope?: string
          p_role: string
          target_id: string
        }
        Returns: Json
      }
      admin_set_user_role: {
        Args: { new_role: string; target_user_id: string }
        Returns: Json
      }
      admin_update_profile: {
        Args: {
          p_department?: string
          p_email?: string
          p_full_name: string
          p_phone?: string
          p_username?: string
          target_id: string
        }
        Returns: Json
      }
      approve_costing_sheet: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_debt_writeoff: {
        Args: { p_comment?: string; p_debt_id: string }
        Returns: Json
      }
      approve_delete: { Args: { p_id: string }; Returns: Json }
      approve_expense: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_new_material: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_payroll: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_production_request: {
        Args: { p_approver_name: string; p_id: string }
        Returns: Json
      }
      approve_role_grant: {
        Args: { p_comment?: string; p_request_id: string }
        Returns: Json
      }
      approve_sale: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_staff_deduction: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_staff_loan: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_stock_adjustment: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      approve_user: {
        Args: {
          granted_role?: string
          p_department?: string
          target_id: string
        }
        Returns: Json
      }
      assert_valid_transition: {
        Args: { p_from: unknown; p_to: unknown }
        Returns: undefined
      }
      avg_unit_cost: {
        Args: { v_fallback: number; v_stock: number; v_value: number }
        Returns: number
      }
      cancel_costing_sheet: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_debt_writeoff: {
        Args: { p_debt_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_expense: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_goods_receipt: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_payroll: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_production: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_purchase_order: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_rep_return: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_role_grant: {
        Args: { p_reason?: string; p_request_id: string }
        Returns: Json
      }
      cancel_sale: { Args: { p_id: string; p_reason?: string }; Returns: Json }
      cancel_sales_return: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_staff_loan: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      cancel_stock_adjustment: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      close_debt: {
        Args: { p_debt_id: string; p_reason?: string }
        Returns: Json
      }
      confirm_goods_receipt: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      confirm_payment: {
        Args: { p_id: string; p_note?: string }
        Returns: Json
      }
      confirm_production_batch: {
        Args: {
          p_actual_received: number
          p_comment?: string
          p_damaged: number
          p_id: string
          p_rejected: number
        }
        Returns: Json
      }
      create_cash_transaction: { Args: { payload: Json }; Returns: Json }
      create_delivery: { Args: { payload: Json }; Returns: Json }
      create_production: { Args: { payload: Json }; Returns: Json }
      create_production_request: { Args: { payload: Json }; Returns: Json }
      create_purchase_order: { Args: { payload: Json }; Returns: Json }
      create_rep_return: { Args: { payload: Json }; Returns: Json }
      create_sale: { Args: { payload: Json }; Returns: Json }
      create_sales_cash_remittance: { Args: { payload: Json }; Returns: Json }
      create_sales_return: { Args: { payload: Json }; Returns: Json }
      create_staff_deduction: { Args: { payload: Json }; Returns: Json }
      create_staff_loan: { Args: { payload: Json }; Returns: Json }
      create_stock_dispatch: { Args: { payload: Json }; Returns: Json }
      delete_user_account: { Args: { target_id: string }; Returns: Json }
      flag_payment: { Args: { p_id: string; p_reason: string }; Returns: Json }
      get_all_users_last_login: {
        Args: never
        Returns: {
          id: string
          last_sign_in_at: string
        }[]
      }
      get_my_permissions: {
        Args: never
        Returns: {
          action: unknown
          module: unknown
        }[]
      }
      get_stock_movement_summary: {
        Args: { p_end: string; p_factory_id: string; p_start: string }
        Returns: {
          closing_stock: number
          damages: number
          new_production: number
          opening_stock: number
          pr: number
          product_id: string
          product_name: string
          quantity_sold: number
          unit: string
        }[]
      }
      has_permission:
        | {
            Args: { _action?: unknown; _module: unknown; _user_id: string }
            Returns: boolean
          }
        | {
            Args: { _level?: unknown; _module: unknown; _user_id: string }
            Returns: boolean
          }
      has_production_scope_access: {
        Args: { _factory_id: string; _user_id: string }
        Returns: boolean
      }
      has_role: { Args: { _role: string; _user_id: string }; Returns: boolean }
      inspect_rep_return: {
        Args: { p_id: string; p_items: Json; p_notes?: string }
        Returns: Json
      }
      inspect_sales_return: {
        Args: {
          p_accepted: number
          p_damaged: number
          p_id: string
          p_notes?: string
          p_rejected: number
        }
        Returns: Json
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      issue_production_request_materials: {
        Args: { payload: Json }
        Returns: Json
      }
      issue_raw_material: { Args: { payload: Json }; Returns: Json }
      post_debt_writeoff: {
        Args: { p_comment?: string; p_debt_id: string }
        Returns: Json
      }
      post_expense: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      post_payroll: {
        Args: { p_comment?: string; p_id: string; p_payment_date?: string }
        Returns: Json
      }
      post_role_grant: {
        Args: { p_comment?: string; p_request_id: string }
        Returns: Json
      }
      post_stock_adjustment: {
        Args: { p_comment?: string; p_id: string }
        Returns: Json
      }
      process_payroll: { Args: { payload: Json }; Returns: Json }
      purge_expired_deleted_sales: { Args: never; Returns: Json }
      record_customer_advance: { Args: { payload: Json }; Returns: Json }
      record_payment: { Args: { payload: Json }; Returns: Json }
      record_rep_remittance: { Args: { payload: Json }; Returns: Json }
      record_workflow_action: {
        Args: {
          p_action: unknown
          p_comment?: string
          p_entity_id: string
          p_from_status: unknown
          p_module: unknown
          p_to_status: unknown
        }
        Returns: string
      }
      reject_costing_sheet: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reject_debt_writeoff: {
        Args: { p_debt_id: string; p_reason?: string }
        Returns: Json
      }
      reject_delete: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      reject_expense: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      reject_goods_receipt: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reject_new_material: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      reject_payment: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reject_payroll: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      reject_production_batch: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reject_production_request: {
        Args: { p_approver_name: string; p_id: string; p_reason?: string }
        Returns: Json
      }
      reject_role_grant: {
        Args: { p_reason?: string; p_request_id: string }
        Returns: Json
      }
      reject_sale: { Args: { p_id: string; p_reason: string }; Returns: Json }
      reject_staff_deduction: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reject_staff_loan: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reject_stock_adjustment: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      reject_user: {
        Args: { reason: string; target_id: string }
        Returns: Json
      }
      rep_account_summary: {
        Args: { p_from?: string; p_sales_rep_id: string; p_to?: string }
        Returns: Json
      }
      request_debt_writeoff: {
        Args: { p_debt_id: string; p_reason?: string }
        Returns: Json
      }
      request_delete: {
        Args: { p_entity_id: string; p_reason: string; p_table_name: string }
        Returns: Json
      }
      request_new_material: { Args: { payload: Json }; Returns: Json }
      set_product_cost_price: {
        Args: { p_id: string; p_cost: number }
        Returns: undefined
      }
      request_role_grant: {
        Args: {
          p_factory_id?: string
          p_role: string
          p_target_user_id: string
        }
        Returns: Json
      }
      request_role_revoke: {
        Args: { p_factory_id?: string; p_role: string; p_user_id: string }
        Returns: Json
      }
      request_stock_adjustment: { Args: { payload: Json }; Returns: Json }
      restore_sale: { Args: { p_id: string }; Returns: Json }
      reverse_debt_writeoff: {
        Args: { p_debt_id: string; p_reason: string }
        Returns: Json
      }
      reverse_expense: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reverse_payment: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reverse_payroll: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reverse_role_grant: {
        Args: { p_reason: string; p_request_id: string }
        Returns: Json
      }
      reverse_stock_adjustment: {
        Args: { p_id: string; p_reason: string }
        Returns: Json
      }
      reverse_stock_dispatch: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      set_production_scope: {
        Args: { p_scope: string; p_user_id: string }
        Returns: Json
      }
      set_user_department: {
        Args: { new_department: string; target_id: string }
        Returns: Json
      }
      set_user_status: {
        Args: { new_status: string; target_id: string }
        Returns: Json
      }
      submit_costing_sheet: { Args: { payload: Json }; Returns: Json }
      submit_goods_receipt: { Args: { payload: Json }; Returns: Json }
      transfer_finished_stock: { Args: { payload: Json }; Returns: Json }
      transfer_raw_material: { Args: { payload: Json }; Returns: Json }
      update_costing_sheet: { Args: { payload: Json }; Returns: Json }
      update_delivery_status: {
        Args: { p_id: string; p_status: string }
        Returns: Json
      }
      update_production: { Args: { payload: Json }; Returns: Json }
      workflow_approval_progress: {
        Args: { p_entity_id: string; p_module: unknown }
        Returns: {
          approvals_so_far: number
          required_approvals: number
          satisfied: boolean
        }[]
      }
    }
    Enums: {
      debt_status: "paid" | "partial" | "unpaid"
      movement_type:
        | "received"
        | "issued"
        | "adjusted"
        | "transferred"
        | "produced"
        | "sold"
        | "damaged"
        | "returned"
        | "used_for_production"
        | "opening_balance"
        | "return_from_production"
        | "expiry"
        | "correction"
        | "dispatched_to_rep"
        | "return_from_rep"
      payment_method: "cash" | "transfer" | "pos" | "card" | "cheque" | "credit"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      debt_status: ["paid", "partial", "unpaid"],
      movement_type: [
        "received",
        "issued",
        "adjusted",
        "transferred",
        "produced",
        "sold",
        "damaged",
        "returned",
        "used_for_production",
        "opening_balance",
        "return_from_production",
        "expiry",
        "correction",
        "dispatched_to_rep",
        "return_from_rep",
      ],
      payment_method: ["cash", "transfer", "pos", "card", "cheque", "credit"],
    },
  },
} as const
