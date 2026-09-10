const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

async function test() {
    console.log('🔍 Testing Supabase connection...');
    console.log('📡 URL:', process.env.SUPABASE_URL);
    
    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );
        
        // Try a simple query
        const { data, error } = await supabase
            .from('registrations')
            .select('count', { count: 'exact', head: true });
        
        if (error) {
            console.log('❌ Supabase error:', error.message);
            console.log('📝 Full error:', JSON.stringify(error, null, 2));
        } else {
            console.log('✅ Supabase connected successfully!');
        }
    } catch (err) {
        console.log('❌ Connection failed:', err.message);
        console.log('📝 Stack:', err.stack);
    }
}

test();