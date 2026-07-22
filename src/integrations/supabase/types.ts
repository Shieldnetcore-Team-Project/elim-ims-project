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
      customers: {
        Row: {
          address: string | null
          created_at: string
          email: string | null
          factory_id: string
          id: string
          name: string
          outstanding_balance: number
          phone: string | null
          total_purchases: number
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          email?: string | null
          factory_id: string
          id?: string
          name: string
          outstanding_balance?: number
          phone?: string | null
          total_purchases?: number
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          email?: string | null
          factory_id?: string
          id?: string
          name?: string
          outstanding_balance?: number
          phone?: string | null
          total_purchases?: number
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
          status: Database["public"]["Enums"]["debt_status"]
          total_amount: number
          updated_at: string
        }
        Insert: {
          amount_paid?: number
          created_at?: string
          customer_id?: string | null
          factory_id: string
          id?: string
          outstanding?: number
          sale_id?: string | null
          status?: Database["public"]["Enums"]["debt_status"]
          total_amount: number
          updated_at?: string
        }
        Update: {
          amount_paid?: number
          created_at?: string
          customer_id?: string | null
          factory_id?: string
          id?: string
          outstanding?: number
          sale_id?: string | null
          status?: Database["public"]["Enums"]["debt_status"]
          total_amount?: number
          updated_at?: string
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
          vendor: string | null
        }
        Insert: {
          amount: number
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
          vendor?: string | null
        }
        Update: {
          amount?: number
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
      inventory_movements: {
        Row: {
          created_at: string
          factory_id: string
          id: string
          movement_type: Database["public"]["Enums"]["movement_type"]
          product_id: string
          quantity: number
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
          sale_id: string | null
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
          sale_id?: string | null
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
          sale_id?: string | null
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
          advance: number
          allowances: number
          basic_salary: number
          created_at: string
          employee_id: string
          factory_id: string
          gross_salary: number
          id: string
          loans: number
          net_salary: number
          other_deductions: number
          overtime: number
          paye: number
          payment_date: string | null
          payment_method: Database["public"]["Enums"]["payment_method"] | null
          pension: number
          period_month: number
          period_year: number
          status: string | null
        }
        Insert: {
          advance?: number
          allowances?: number
          basic_salary?: number
          created_at?: string
          employee_id: string
          factory_id: string
          gross_salary?: number
          id?: string
          loans?: number
          net_salary?: number
          other_deductions?: number
          overtime?: number
          paye?: number
          payment_date?: string | null
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          pension?: number
          period_month: number
          period_year: number
          status?: string | null
        }
        Update: {
          advance?: number
          allowances?: number
          basic_salary?: number
          created_at?: string
          employee_id?: string
          factory_id?: string
          gross_salary?: number
          id?: string
          loans?: number
          net_salary?: number
          other_deductions?: number
          overtime?: number
          paye?: number
          payment_date?: string | null
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          pension?: number
          period_month?: number
          period_year?: number
          status?: string | null
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
      product_categories: {
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
            foreignKeyName: "product_categories_factory_id_fkey"
            columns: ["factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
            referencedColumns: ["id"]
          },
        ]
      }
      production: {
        Row: {
          batch_number: string | null
          created_at: string
          created_by: string | null
          factory_id: string
          id: string
          product_id: string
          production_cost: number | null
          production_date: string
          production_number: string
          quantity_produced: number
          remarks: string | null
          supervisor: string | null
          unit: string | null
        }
        Insert: {
          batch_number?: string | null
          created_at?: string
          created_by?: string | null
          factory_id: string
          id?: string
          product_id: string
          production_cost?: number | null
          production_date?: string
          production_number: string
          quantity_produced: number
          remarks?: string | null
          supervisor?: string | null
          unit?: string | null
        }
        Update: {
          batch_number?: string | null
          created_at?: string
          created_by?: string | null
          factory_id?: string
          id?: string
          product_id?: string
          production_cost?: number | null
          production_date?: string
          production_number?: string
          quantity_produced?: number
          remarks?: string | null
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
        ]
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
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          active_factory_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          active_factory_id?: string | null
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_active_factory_id_fkey"
            columns: ["active_factory_id"]
            isOneToOne: false
            referencedRelation: "factories"
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
          category: string | null
          created_at: string
          current_stock: number
          factory_id: string
          id: string
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
          category?: string | null
          created_at?: string
          current_stock?: number
          factory_id: string
          id?: string
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
          category?: string | null
          created_at?: string
          current_stock?: number
          factory_id?: string
          id?: string
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
          balance: number
          created_at: string
          created_by: string | null
          customer_address: string | null
          customer_id: string | null
          customer_name: string | null
          customer_phone: string | null
          discount: number
          factory_id: string
          grand_total: number
          id: string
          invoice_number: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          remarks: string | null
          sale_date: string
          sales_person: string | null
          subtotal: number
          vat: number
        }
        Insert: {
          amount_paid?: number
          balance?: number
          created_at?: string
          created_by?: string | null
          customer_address?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          discount?: number
          factory_id: string
          grand_total?: number
          id?: string
          invoice_number: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          remarks?: string | null
          sale_date?: string
          sales_person?: string | null
          subtotal?: number
          vat?: number
        }
        Update: {
          amount_paid?: number
          balance?: number
          created_at?: string
          created_by?: string | null
          customer_address?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          discount?: number
          factory_id?: string
          grand_total?: number
          id?: string
          invoice_number?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          remarks?: string | null
          sale_date?: string
          sales_person?: string | null
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
      suppliers: {
        Row: {
          address: string | null
          created_at: string
          email: string | null
          factory_id: string
          id: string
          materials_supplied: string | null
          name: string
          outstanding_balance: number
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          email?: string | null
          factory_id: string
          id?: string
          materials_supplied?: string | null
          name: string
          outstanding_balance?: number
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          email?: string | null
          factory_id?: string
          id?: string
          materials_supplied?: string | null
          name?: string
          outstanding_balance?: number
          phone?: string | null
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
      user_roles: {
        Row: {
          created_at: string
          factory_id: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          factory_id?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          factory_id?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
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
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_sale: { Args: { payload: Json }; Returns: Json }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      record_payment: { Args: { payload: Json }; Returns: Json }
    }
    Enums: {
      app_role:
        | "super_admin"
        | "factory_manager"
        | "sales_manager"
        | "sales_officer"
        | "production_manager"
        | "production_officer"
        | "inventory_manager"
        | "store_keeper"
        | "hr"
        | "payroll_officer"
        | "accountant"
        | "auditor"
        | "viewer"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "super_admin",
        "factory_manager",
        "sales_manager",
        "sales_officer",
        "production_manager",
        "production_officer",
        "inventory_manager",
        "store_keeper",
        "hr",
        "payroll_officer",
        "accountant",
        "auditor",
        "viewer",
      ],
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
      ],
      payment_method: ["cash", "transfer", "pos", "card", "cheque", "credit"],
    },
  },
} as const
