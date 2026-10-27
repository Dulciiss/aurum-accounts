if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) {
    console.error('Signed builds require CSC_LINK and CSC_KEY_PASSWORD to be set.');
    process.exit(1);
}
